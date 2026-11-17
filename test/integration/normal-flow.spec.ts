import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
const request = require('supertest');
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { JudgeWorkerService } from '../../src/judge/worker/judge-worker.service';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { SAMPLE_PROGRAMS } from '../../prisma/seed';

describe('Stage 1 & 2: Normal Flow Verification', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: JudgeWorkerService;
  let student1Token: string;
  let student2Token: string;
  let organizerAlphaToken: string;
  let contestAlphaId: string;
  let probAId: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    worker = app.get(JudgeWorkerService);

    // Fetch tokens via dev-tokens endpoint
    const res1 = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-tokens')
      .send({ email: 'student1@shodh.test' });
    student1Token = res1.body.accessToken;

    const res2 = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-tokens')
      .send({ email: 'student2@shodh.test' });
    student2Token = res2.body.accessToken;

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

  it('1. Participant can register for contest idempotently', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/register`)
      .set('Authorization', `Bearer ${student1Token}`)
      .expect(201);

    expect(res.body).toHaveProperty('contestId', contestAlphaId);
  });

  it('2. Immediate submission acceptance: returns ID without waiting for judge execution', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/submissions`)
      .set('Authorization', `Bearer ${student1Token}`)
      .send({
        problemId: probAId,
        language: 'python3',
        sourceCode: SAMPLE_PROGRAMS.CORRECT_SUM,
      })
      .expect(201);

    expect(res.body).toHaveProperty('id');
    expect(res.body.status).toBe('QUEUED');
    expect(res.body.verdict).toBe('PENDING');

    const submissionId = res.body.id;

    // Verify submission is persisted immediately in database with attempt and judge job
    const stored = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: { attempts: true, judgeJobs: true },
    });
    expect(stored).toBeDefined();
    expect(stored?.attempts.length).toBe(1);
    expect(stored?.judgeJobs.length).toBe(1);
    expect(stored?.judgeJobs[0].status).toBe('QUEUED');

    // Worker processes job
    const processed = await worker.claimAndProcessNextJob();
    expect(processed).toBe(true);

    // Verify final verdict is ACCEPTED
    const finalSub = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: { attempts: true },
    });
    expect(finalSub?.status).toBe('COMPLETED');
    expect(finalSub?.verdict).toBe('ACCEPTED');
    expect(finalSub?.score).toBe(100);
  });

  it('3. Standings and Leaderboard are updated accurately with deterministic ranking', async () => {
    // Student 2 submits a WRONG answer first, then a CORRECT answer
    const wrongRes = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/submissions`)
      .set('Authorization', `Bearer ${student2Token}`)
      .send({
        problemId: probAId,
        language: 'python3',
        sourceCode: SAMPLE_PROGRAMS.WRONG_SUM,
      })
      .expect(201);

    await worker.claimAndProcessNextJob();

    const wrongSub = await prisma.submission.findUnique({ where: { id: wrongRes.body.id } });
    expect(wrongSub?.verdict).toBe('WRONG_ANSWER');

    // Now Student 2 submits CORRECT answer
    const correctRes = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/submissions`)
      .set('Authorization', `Bearer ${student2Token}`)
      .send({
        problemId: probAId,
        language: 'python3',
        sourceCode: SAMPLE_PROGRAMS.CORRECT_SUM,
      })
      .expect(201);

    await worker.claimAndProcessNextJob();

    // Query Leaderboard
    const lbRes = await request(app.getHttpServer())
      .get(`/api/v1/contests/${contestAlphaId}/leaderboard`)
      .expect(200);

    expect(lbRes.body.data.length).toBeGreaterThanOrEqual(2);
    // Student 1 solved with 0 failed attempts, Student 2 solved with 1 failed attempt (penalty added)
    const rank1 = lbRes.body.data[0];
    const rank2 = lbRes.body.data[1];

    expect(rank1.score).toBe(100);
    expect(rank2.score).toBe(100);
    expect(rank1.penaltyTimeSec).toBeLessThan(rank2.penaltyTimeSec);
  });
});
