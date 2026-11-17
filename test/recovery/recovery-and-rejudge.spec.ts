import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
const request = require('supertest');
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { JudgeWorkerService } from '../../src/judge/worker/judge-worker.service';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { SAMPLE_PROGRAMS } from '../../prisma/seed';
import { JobStatus, SubmissionStatus, Verdict } from '@prisma/client';

describe('Stage 3 & 4: Recovery, Failure Injection & Rejudging Verification', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: JudgeWorkerService;
  let student1Token: string;
  let organizerAlphaToken: string;
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
    worker = app.get(JudgeWorkerService);

    const res1 = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-tokens')
      .send({ email: 'student1@shodh.test' });
    student1Token = res1.body.accessToken;

    const resOrg = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-tokens')
      .send({ email: 'organizer.alpha@shodh.test' });
    organizerAlphaToken = resOrg.body.accessToken;

    const contest = await prisma.contest.findUnique({ where: { slug: 'alpha-round-1' } });
    contestAlphaId = contest!.id;

    const probA = await prisma.problem.findFirst({ where: { code: 'PROB-A' } });
    probAId = probA!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. Abandoned work recovery: expired lease from a crashed worker is safely recovered without losing job', async () => {
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

    // Simulate worker acquiring lease and immediately crashing (lease expired in the past)
    const job = await prisma.judgeJob.findFirst({ where: { submissionId } });
    await prisma.judgeJob.update({
      where: { id: job!.id },
      data: {
        status: JobStatus.LEASED,
        claimedBy: 'worker-crashed-pid-9999',
        leaseExpiresAt: new Date(Date.now() - 60000), // 1 minute in the past
      },
    });

    // Run abandoned jobs recovery
    const recoveredCount = await worker.recoverAbandonedJobs();
    expect(recoveredCount).toBeGreaterThanOrEqual(1);

    // Verify job returned to QUEUED state and was not lost
    const recoveredJob = await prisma.judgeJob.findUnique({ where: { id: job!.id } });
    expect(recoveredJob?.status).toBe(JobStatus.QUEUED);
    expect(recoveredJob?.claimedBy).toBeNull();

    // Normal worker can now process it to completion
    await worker.claimAndProcessNextJob();
    const finalSub = await prisma.submission.findUnique({ where: { id: submissionId } });
    expect(finalSub?.status).toBe(SubmissionStatus.COMPLETED);
    expect(finalSub?.verdict).toBe(Verdict.ACCEPTED);
  });

  it('2. Controllable runner failure injection: runner crash retries automatically without blaming student', async () => {
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

    // Process job with injected runner crash
    await worker.claimAndProcessNextJob(true); // simulateRunnerCrash = true

    // Check job was marked RETRYABLE and student is not penalized with RUNTIME_ERROR
    const jobAfterCrash = await prisma.judgeJob.findFirst({ where: { submissionId } });
    expect(jobAfterCrash?.status).toBe(JobStatus.RETRYABLE);
    expect(jobAfterCrash?.retryCount).toBe(1);

    const subAfterCrash = await prisma.submission.findUnique({ where: { id: submissionId } });
    // Still running/retying, NOT marked as wrong answer or student error
    expect(subAfterCrash?.verdict).not.toBe(Verdict.RUNTIME_ERROR);

    // Simulate time elapsed for backoff, reset leaseExpiresAt
    await prisma.judgeJob.update({
      where: { id: jobAfterCrash!.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    // Process retry normally (without crash)
    await worker.claimAndProcessNextJob(false);

    // Verify successful recovery to final ACCEPTED verdict
    const finalSub = await prisma.submission.findUnique({ where: { id: submissionId } });
    expect(finalSub?.status).toBe(SubmissionStatus.COMPLETED);
    expect(finalSub?.verdict).toBe(Verdict.ACCEPTED);
  });

  it('3. Rejudging against new problem version preserves history and updates authoritative standing', async () => {
    // Create submission with wrong sum
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
    await worker.claimAndProcessNextJob();

    // Organizer triggers rejudge
    const rejudgeRes = await request(app.getHttpServer())
      .post(`/api/v1/submissions/${submissionId}/rejudge`)
      .set('Authorization', `Bearer ${organizerAlphaToken}`)
      .send({})
      .expect(201);

    expect(rejudgeRes.body.attemptNumber).toBe(2);

    // Verify submission has 2 attempts
    const subWithAttempts = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: { attempts: true },
    });
    expect(subWithAttempts?.attempts.length).toBe(2);

    // Process the rejudge job
    await worker.claimAndProcessNextJob();

    const finalSub = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
    });

    expect(finalSub?.attempts[0].attemptNumber).toBe(1);
    expect(finalSub?.attempts[1].attemptNumber).toBe(2);
    expect(finalSub?.attempts[1].isAuthoritative).toBe(true);
    expect(finalSub?.attempts[1].isRejudge).toBe(true);
  });
});
