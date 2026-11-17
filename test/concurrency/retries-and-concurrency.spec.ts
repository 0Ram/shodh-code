import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
const request = require('supertest');
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { JudgeWorkerService } from '../../src/judge/worker/judge-worker.service';
import { JudgeService } from '../../src/judge/judge.service';
import { AppLoggerService } from '../../src/common/logger/app-logger.service';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { SAMPLE_PROGRAMS } from '../../prisma/seed';
import { generateFencingToken } from '../../src/common/utils/hash.util';
import { Verdict, SubmissionStatus, JobStatus } from '@prisma/client';
import { spawn } from 'child_process';

describe('Stage 3: Retries and Concurrency Verification', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker1: JudgeWorkerService;
  let worker2: JudgeWorkerService;
  let student1Token: string;
  let contestAlphaId: string;
  let probAId: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    worker1 = app.get(JudgeWorkerService);
    worker2 = new JudgeWorkerService(prisma, app.get(JudgeService), app.get(AppLoggerService));

    const res1 = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-tokens')
      .send({ email: 'student1@shodh.test' });
    student1Token = res1.body.accessToken;

    const contest = await prisma.contest.findUnique({ where: { slug: 'alpha-round-1' } });
    contestAlphaId = contest!.id;

    const probA = await prisma.problem.findFirst({ where: { code: 'PROB-A' } });
    probAId = probA!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. Idempotency Barrier: Simultaneous concurrent requests with same key return identical submission', async () => {
    const key = `idem-barrier-${Date.now()}`;

    const makeRequest = () =>
      request(app.getHttpServer())
        .post(`/api/v1/contests/${contestAlphaId}/submissions`)
        .set('Authorization', `Bearer ${student1Token}`)
        .set('x-idempotency-key', key)
        .send({
          problemId: probAId,
          language: 'python3',
          sourceCode: SAMPLE_PROGRAMS.CORRECT_SUM,
        });

    // Concurrent dispatch barrier: both requests fire simultaneously
    const [res1, res2] = await Promise.all([makeRequest(), makeRequest()]);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.id).toBe(res2.body.id);
  });

  it('2. Idempotency Conflict: reusing same key with different payload returns explicit HTTP 409', async () => {
    const key = `conflict-key-${Date.now()}`;

    await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/submissions`)
      .set('Authorization', `Bearer ${student1Token}`)
      .set('x-idempotency-key', key)
      .send({
        problemId: probAId,
        language: 'python3',
        sourceCode: SAMPLE_PROGRAMS.CORRECT_SUM,
      })
      .expect(201);

    // Reuse key with modified source code
    const res = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/submissions`)
      .set('Authorization', `Bearer ${student1Token}`)
      .set('x-idempotency-key', key)
      .send({
        problemId: probAId,
        language: 'python3',
        sourceCode: 'print(42)', // Different code
      })
      .expect(409);

    expect(res.body.error).toBe('Conflict');
    expect(res.body.message).toContain('already used with a different request payload');
  });

  it('3. Competing workers: 2 independent workers competing via SKIP LOCKED do not duplicate jobs or verdicts', async () => {
    // Drain any pending queued jobs from previous tests
    while (await worker1.claimAndProcessNextJob()) {}

    // Create single submission
    const res = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/submissions`)
      .set('Authorization', `Bearer ${student1Token}`)
      .send({
        problemId: probAId,
        language: 'python3',
        sourceCode: SAMPLE_PROGRAMS.CORRECT_SUM,
      })
      .expect(201);

    const submissionId = res.body.id;

    // Both workers attempt to claim simultaneously
    const [p1, p2] = await Promise.all([
      worker1.claimAndProcessNextJob(),
      worker2.claimAndProcessNextJob(),
    ]);

    // Exactly one worker must claim the job, the second gets false (no jobs available)
    expect([p1, p2].filter(Boolean).length).toBe(1);

    // Verify submission is processed cleanly exactly once
    const sub = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: { attempts: true, judgeJobs: true },
    });

    expect(sub?.status).toBe(SubmissionStatus.COMPLETED);
    expect(sub?.attempts.length).toBe(1);
    expect(sub?.judgeJobs[0].status).toBe(JobStatus.COMPLETED);
  });

  it('4. Attempt fencing: Delayed result from older attempt cannot overwrite newer authoritative attempt', async () => {
    // Create submission
    const res = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/submissions`)
      .set('Authorization', `Bearer ${student1Token}`)
      .send({
        problemId: probAId,
        language: 'python3',
        sourceCode: SAMPLE_PROGRAMS.CORRECT_SUM,
      })
      .expect(201);

    const submissionId = res.body.id;

    // Manually create Attempt 2 with higher fencing token (simulating an organizer rejudge completing first)
    const tokenNewer = generateFencingToken() + 1000n;
    const attempt2 = await prisma.submissionAttempt.create({
      data: {
        submissionId,
        attemptNumber: 2,
        fencingToken: tokenNewer,
        status: SubmissionStatus.COMPLETED,
        verdict: Verdict.ACCEPTED,
        score: 100,
        isAuthoritative: true,
        finishedAt: new Date(),
      },
    });

    await prisma.submission.update({
      where: { id: submissionId },
      data: {
        status: SubmissionStatus.COMPLETED,
        verdict: Verdict.ACCEPTED,
        score: 100,
        authoritativeAttemptId: attempt2.id,
      },
    });

    // Now Attempt 1 (older worker) tries to finalize with a stale WRONG_ANSWER
    const attempt1 = await prisma.submissionAttempt.findFirst({
      where: { submissionId, attemptNumber: 1 },
    });
    const job1 = await prisma.judgeJob.findFirst({ where: { submissionId, attemptId: attempt1!.id } });

    // Finalize attempt 1 using worker internal fencing logic
    await (worker1 as any).finalizeAttemptWithFencing(job1!.id, submissionId, attempt1!.id, {
      verdict: Verdict.WRONG_ANSWER,
      score: 0,
      maxExecutionTimeMs: 15,
      maxMemoryUsageMb: 16,
    });

    // Verify submission authoritative verdict is STILL ACCEPTED from Attempt 2!
    const finalSub = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
    });

    expect(finalSub?.verdict).toBe(Verdict.ACCEPTED);
    expect(finalSub?.score).toBe(100);
    expect(finalSub?.authoritativeAttemptId).toBe(attempt2.id);

    // Stale Attempt 1 was marked non-authoritative
    const att1After = finalSub?.attempts.find((a) => a.attemptNumber === 1);
    expect(att1After?.isAuthoritative).toBe(false);
    expect(att1After?.verdict).toBe(Verdict.WRONG_ANSWER);
  });
});
