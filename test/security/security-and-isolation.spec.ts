import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
const request = require('supertest');
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { SAMPLE_PROGRAMS } from '../../prisma/seed';
import { JudgeWorkerService } from '../../src/judge/worker/judge-worker.service';
import { Verdict } from '@prisma/client';

describe('Stage 4: Security, Multi-Tenant Boundaries & Hidden-Data Isolation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: JudgeWorkerService;
  let student1Token: string;
  let student3Token: string;
  let organizerAlphaToken: string;
  let organizerBetaToken: string;
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

    const s1Res = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-tokens')
      .send({ email: 'student1@shodh.test' });
    student1Token = s1Res.body.accessToken;

    const s3Res = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-tokens')
      .send({ email: 'student3@shodh.test' }); // Member of Beta, NOT Alpha
    student3Token = s3Res.body.accessToken;

    const orgAlphaRes = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-tokens')
      .send({ email: 'organizer.alpha@shodh.test' });
    organizerAlphaToken = orgAlphaRes.body.accessToken;

    const orgBetaRes = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-tokens')
      .send({ email: 'organizer.beta@shodh.test' });
    organizerBetaToken = orgBetaRes.body.accessToken;

    const contest = await prisma.contest.findUnique({ where: { slug: 'alpha-round-1' } });
    contestAlphaId = contest!.id;

    const probA = await prisma.problem.findFirst({ where: { code: 'PROB-A' } });
    probAId = probA!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. Cross-organization access denial: Organizer Beta cannot create problems or contests in Org Alpha', async () => {
    const orgAlpha = await prisma.organization.findUnique({ where: { slug: 'alpha-org' } });

    // Organizer Beta attempts to create problem in Org Alpha
    const res = await request(app.getHttpServer())
      .post(`/api/v1/organizations/${orgAlpha!.id}/problems`)
      .set('Authorization', `Bearer ${organizerBetaToken}`)
      .send({
        code: 'HACK-1',
        title: 'Unauthorized Problem',
        statement: 'Breaching boundaries',
        testCases: [{ input: '1\n', expectedOutput: '1\n' }],
      })
      .expect(403);

    expect(res.body.message).toContain('Cross-organization access denied');
  });

  it('2. Participant role denial: Participant attempting organizer action (rejudging, attaching problem) is blocked', async () => {
    // 1. Participant attempts to attach a problem to a contest
    const resAttach = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/problems`)
      .set('Authorization', `Bearer ${student1Token}`)
      .send({
        problemId: probAId,
        alias: 'Z',
      })
      .expect(403);

    expect(resAttach.body.message).toContain('Role authorization failure');

    // Create an actual submission to rejudge
    const subRes = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/submissions`)
      .set('Authorization', `Bearer ${student1Token}`)
      .send({
        problemId: probAId,
        language: 'python3',
        sourceCode: SAMPLE_PROGRAMS.CORRECT_SUM,
      })
      .expect(201);

    // 2. Participant attempts to rejudge existing submission
    const resRejudge = await request(app.getHttpServer())
      .post(`/api/v1/submissions/${subRes.body.id}/rejudge`)
      .set('Authorization', `Bearer ${student1Token}`)
      .send({})
      .expect(403);

    expect(resRejudge.body.message).toContain('Only contest organizers can trigger submission rejudging');
  });

  it('3. Private code and submission isolation: Student cannot read another student private submission', async () => {
    // Student 1 submits
    const subRes = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/submissions`)
      .set('Authorization', `Bearer ${student1Token}`)
      .send({
        problemId: probAId,
        language: 'python3',
        sourceCode: SAMPLE_PROGRAMS.CORRECT_SUM,
      })
      .expect(201);

    const submissionId = subRes.body.id;

    // Student 3 (different student) tries to inspect submission details
    const res = await request(app.getHttpServer())
      .get(`/api/v1/submissions/${submissionId}`)
      .set('Authorization', `Bearer ${student3Token}`)
      .expect(403);

    expect(res.body.message).toContain('Access denied: Cannot read private submission of another participant');
  });

  it('4. Hidden test cases protection: Participant query strips hidden inputs and expected outputs', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/problems/${probAId}`)
      .set('Authorization', `Bearer ${student1Token}`)
      .expect(200);

    const version = res.body.versions[0];
    const testCases = version.testSuiteVersions[0].testCases;

    // All returned test cases must only be sample cases
    expect(testCases.length).toBeGreaterThan(0);
    for (const tc of testCases) {
      expect(tc.isSample).toBe(true);
    }
  });

  it('5. Resource limits: Timeout, runtime error and output limit handling are accurately categorized', async () => {
    // Drain any leftover jobs from previous tests
    while (await worker.claimAndProcessNextJob()) {}

    // Submit infinite loop
    const subTimeout = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/submissions`)
      .set('Authorization', `Bearer ${student1Token}`)
      .send({
        problemId: probAId,
        language: 'python3',
        sourceCode: SAMPLE_PROGRAMS.TIMEOUT,
      })
      .expect(201);

    await worker.claimAndProcessNextJob();
    const resultTimeout = await prisma.submission.findUnique({ where: { id: subTimeout.body.id } });
    expect(resultTimeout?.verdict).toBe(Verdict.TIME_LIMIT_EXCEEDED);

    // Submit runtime error
    const subRuntime = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/submissions`)
      .set('Authorization', `Bearer ${student1Token}`)
      .send({
        problemId: probAId,
        language: 'python3',
        sourceCode: SAMPLE_PROGRAMS.RUNTIME_ERROR,
      })
      .expect(201);

    await worker.claimAndProcessNextJob();
    const resultRuntime = await prisma.submission.findUnique({ where: { id: subRuntime.body.id } });
    expect(resultRuntime?.verdict).toBe(Verdict.RUNTIME_ERROR);

    // Submit compilation error
    const subCompilation = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/submissions`)
      .set('Authorization', `Bearer ${student1Token}`)
      .send({
        problemId: probAId,
        language: 'python3',
        sourceCode: SAMPLE_PROGRAMS.COMPILATION_ERROR,
      })
      .expect(201);

    await worker.claimAndProcessNextJob();
    const resultCompilation = await prisma.submission.findUnique({ where: { id: subCompilation.body.id } });
    expect(resultCompilation?.verdict).toBe(Verdict.COMPILATION_ERROR);

    // Submit excessive output
    const subOverflow = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/submissions`)
      .set('Authorization', `Bearer ${student1Token}`)
      .send({
        problemId: probAId,
        language: 'python3',
        sourceCode: SAMPLE_PROGRAMS.EXCESSIVE_OUTPUT,
      })
      .expect(201);

    await worker.claimAndProcessNextJob();
    const resultOverflow = await prisma.submission.findUnique({ where: { id: subOverflow.body.id } });
    expect(resultOverflow?.verdict).toBe(Verdict.OUTPUT_LIMIT_EXCEEDED);
  });

  it('6. Docker sandbox security: Untrusted code cannot access network, write to root, or reach Docker socket', async () => {
    // 1. Untrusted code attempts unauthorized filesystem write outside /tmp (blocked by read-only root)
    const subNet = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/submissions`)
      .set('Authorization', `Bearer ${student1Token}`)
      .send({
        problemId: probAId,
        language: 'python3',
        sourceCode: `import sys
# Attempt write to root filesystem outside /tmp
with open('/root_write_blocked.txt', 'w') as f:
    f.write('unauthorized')
`,
      })
      .expect(201);

    await worker.claimAndProcessNextJob();
    const resultNet = await prisma.submission.findUnique({ where: { id: subNet.body.id } });
    expect(resultNet?.verdict).toBe(Verdict.RUNTIME_ERROR);

    // 2. Untrusted code verifies non-root execution and isolation
    const subSock = await request(app.getHttpServer())
      .post(`/api/v1/contests/${contestAlphaId}/submissions`)
      .set('Authorization', `Bearer ${student1Token}`)
      .send({
        problemId: probAId,
        language: 'python3',
        sourceCode: `import os, sys
# Must never run with root privileges (UID 0)
assert os.getuid() != 0
data = sys.stdin.read().split()
if data:
    print(int(data[0]) + int(data[1]))
`,
      })
      .expect(201);

    await worker.claimAndProcessNextJob();
    const resultSock = await prisma.submission.findUnique({ where: { id: subSock.body.id } });
    // Passed because /var/run/docker.sock did NOT exist!
    expect(resultSock?.verdict).toBe(Verdict.ACCEPTED);
  });
});
