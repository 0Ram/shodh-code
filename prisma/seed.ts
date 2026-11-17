import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient, GlobalRole, OrgRole, ContestStatus, SubmissionStatus, Verdict, JobStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

export const SAMPLE_PROGRAMS = {
  CORRECT_SUM: `import sys
input_data = sys.stdin.read().split()
if input_data:
    a, b = map(int, input_data[:2])
    print(a + b)
`,
  WRONG_SUM: `import sys
input_data = sys.stdin.read().split()
if input_data:
    a, b = map(int, input_data[:2])
    print(a - b) # Wrong answer intentional
`,
  COMPILATION_ERROR: `def invalid_syntax(
print("Syntax error missing colon and paren"
`,
  RUNTIME_ERROR: `import sys
input_data = sys.stdin.read().split()
if input_data:
    a, b = map(int, input_data[:2])
    print(a // 0) # Zero division error
`,
  TIMEOUT: `import time
while True:
    time.sleep(1)
`,
  EXCESSIVE_OUTPUT: `import sys
for _ in range(20000):
    sys.stdout.write("OVERFLOW_" * 10 + "\\n")
`,
  CORRECT_PALINDROME: `import sys
s = sys.stdin.read().strip()
if s == s[::-1]:
    print("YES")
else:
    print("NO")
`,
  CORRECT_EXPONENTIATION: `import sys
data = sys.stdin.read().split()
if data:
    base, exp = map(int, data[:2])
    MOD = 1000000007
    print(pow(base, exp, MOD))
`
};

async function main() {
  console.log('--- Cleaning previous seed data ---');
  await prisma.leaderboardRow.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.judgeJob.deleteMany();
  await prisma.submissionAttempt.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.submission.deleteMany();
  await prisma.testCase.deleteMany();
  await prisma.testSuiteVersion.deleteMany();
  await prisma.problemVersion.deleteMany();
  await prisma.contestProblem.deleteMany();
  await prisma.problem.deleteMany();
  await prisma.contestParticipant.deleteMany();
  await prisma.contest.deleteMany();
  await prisma.organizationMember.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();

  console.log('--- Seeding deterministic users ---');
  const passwordHash = await bcrypt.hash('password123', 10);

  const superadmin = await prisma.user.create({
    data: {
      email: 'superadmin@shodh.test',
      name: 'Super Admin',
      passwordHash,
      globalRole: GlobalRole.SUPERADMIN,
    },
  });

  const orgAlphaAdmin = await prisma.user.create({
    data: {
      email: 'organizer.alpha@shodh.test',
      name: 'Alpha Organizer',
      passwordHash,
      globalRole: GlobalRole.USER,
    },
  });

  const orgBetaAdmin = await prisma.user.create({
    data: {
      email: 'organizer.beta@shodh.test',
      name: 'Beta Organizer',
      passwordHash,
      globalRole: GlobalRole.USER,
    },
  });

  const student1 = await prisma.user.create({
    data: {
      email: 'student1@shodh.test',
      name: 'Alice Student',
      passwordHash,
      globalRole: GlobalRole.USER,
    },
  });

  const student2 = await prisma.user.create({
    data: {
      email: 'student2@shodh.test',
      name: 'Bob Student',
      passwordHash,
      globalRole: GlobalRole.USER,
    },
  });

  const student3 = await prisma.user.create({
    data: {
      email: 'student3@shodh.test',
      name: 'Charlie Student',
      passwordHash,
      globalRole: GlobalRole.USER,
    },
  });

  console.log('--- Seeding organizations and memberships ---');
  const orgAlpha = await prisma.organization.create({
    data: {
      id: '1838faa4-319d-4dc2-845e-f8019f0de222',
      name: 'Alpha Tech Contest Org',
      slug: 'alpha-org',
    },
  });

  const orgBeta = await prisma.organization.create({
    data: {
      id: 'e5683172-2e29-47ac-bf0a-99c1e1f4e80d',
      name: 'Beta University',
      slug: 'beta-org',
    },
  });

  // Alpha Memberships
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: orgAlpha.id, userId: orgAlphaAdmin.id, role: OrgRole.ORGANIZER },
      { organizationId: orgAlpha.id, userId: student1.id, role: OrgRole.PARTICIPANT },
      { organizationId: orgAlpha.id, userId: student2.id, role: OrgRole.PARTICIPANT },
    ],
  });

  // Beta Memberships
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: orgBeta.id, userId: orgBetaAdmin.id, role: OrgRole.ORGANIZER },
      { organizationId: orgBeta.id, userId: student1.id, role: OrgRole.PARTICIPANT },
      { organizationId: orgBeta.id, userId: student3.id, role: OrgRole.PARTICIPANT },
    ],
  });

  console.log('--- Seeding contests ---');
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600 * 1000);
  const oneDayLater = new Date(now.getTime() + 24 * 3600 * 1000);
  const twoDaysLater = new Date(now.getTime() + 48 * 3600 * 1000);
  const threeDaysLater = new Date(now.getTime() + 72 * 3600 * 1000);

  const contestAlpha = await prisma.contest.create({
    data: {
      id: '64c1c05c-5ef8-44ca-9f19-f72821ae5255',
      organizationId: orgAlpha.id,
      title: 'Alpha Code Sprint 2026',
      slug: 'alpha-round-1',
      description: 'Active coding contest for Alpha Org members',
      startTime: oneHourAgo,
      endTime: oneDayLater,
      status: ContestStatus.ACTIVE,
      scoringRule: 'ICPC',
      penaltyPerFailedAttemptSec: 1200,
    },
  });

  const contestBeta = await prisma.contest.create({
    data: {
      id: '928c53ce-7679-4423-8a04-9e2fc4fc1ad9',
      organizationId: orgBeta.id,
      title: 'Beta Collegiate Championship',
      slug: 'beta-finals',
      description: 'Upcoming championship contest',
      startTime: twoDaysLater,
      endTime: threeDaysLater,
      status: ContestStatus.UPCOMING,
      scoringRule: 'ICPC',
      penaltyPerFailedAttemptSec: 1200,
    },
  });

  // Contest Participants
  await prisma.contestParticipant.createMany({
    data: [
      { contestId: contestAlpha.id, userId: student1.id },
      { contestId: contestAlpha.id, userId: student2.id },
      { contestId: contestBeta.id, userId: student1.id },
      { contestId: contestBeta.id, userId: student3.id },
    ],
  });

  console.log('--- Seeding versioned problems and test cases ---');

  // Problem A: Sum of Two Numbers
  const probA = await prisma.problem.create({
    data: {
      id: 'a0000000-0000-0000-0000-000000000001',
      organizationId: orgAlpha.id,
      code: 'PROB-A',
      title: 'Sum of Two Numbers',
      description: 'Given two integers a and b, compute their sum a + b.',
    },
  });

  const probAVer1 = await prisma.problemVersion.create({
    data: {
      problemId: probA.id,
      versionNumber: 1,
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      statement: 'Given two integers a and b on standard input, print their sum to standard output.',
    },
  });

  const probASuite1 = await prisma.testSuiteVersion.create({
    data: {
      problemVersionId: probAVer1.id,
      versionNumber: 1,
      isAuthoritative: true,
    },
  });

  await prisma.testCase.createMany({
    data: [
      {
        testSuiteVersionId: probASuite1.id,
        input: '3 5\n',
        expectedOutput: '8\n',
        isSample: true,
        weight: 20,
        orderIndex: 0,
      },
      {
        testSuiteVersionId: probASuite1.id,
        input: '100 250\n',
        expectedOutput: '350\n',
        isSample: false,
        weight: 40,
        orderIndex: 1,
      },
      {
        testSuiteVersionId: probASuite1.id,
        input: '-50 20\n',
        expectedOutput: '-30\n',
        isSample: false,
        weight: 40,
        orderIndex: 2,
      },
    ],
  });

  await prisma.problem.update({
    where: { id: probA.id },
    data: { currentVersionId: probAVer1.id },
  });

  // Problem B: Palindrome Checker
  const probB = await prisma.problem.create({
    data: {
      id: 'a0000000-0000-0000-0000-000000000002',
      organizationId: orgAlpha.id,
      code: 'PROB-B',
      title: 'Palindrome Checker',
      description: 'Determine whether a given string reads the same forwards and backwards.',
    },
  });

  const probBVer1 = await prisma.problemVersion.create({
    data: {
      problemId: probB.id,
      versionNumber: 1,
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      statement: 'Given a single word s, output YES if s is a palindrome, or NO otherwise.',
    },
  });

  const probBSuite1 = await prisma.testSuiteVersion.create({
    data: {
      problemVersionId: probBVer1.id,
      versionNumber: 1,
      isAuthoritative: true,
    },
  });

  await prisma.testCase.createMany({
    data: [
      {
        testSuiteVersionId: probBSuite1.id,
        input: 'racecar\n',
        expectedOutput: 'YES\n',
        isSample: true,
        weight: 25,
        orderIndex: 0,
      },
      {
        testSuiteVersionId: probBSuite1.id,
        input: 'hello\n',
        expectedOutput: 'NO\n',
        isSample: true,
        weight: 25,
        orderIndex: 1,
      },
      {
        testSuiteVersionId: probBSuite1.id,
        input: 'abccba\n',
        expectedOutput: 'YES\n',
        isSample: false,
        weight: 25,
        orderIndex: 2,
      },
      {
        testSuiteVersionId: probBSuite1.id,
        input: 'contest\n',
        expectedOutput: 'NO\n',
        isSample: false,
        weight: 25,
        orderIndex: 3,
      },
    ],
  });

  await prisma.problem.update({
    where: { id: probB.id },
    data: { currentVersionId: probBVer1.id },
  });

  // Problem C: Fast Exponentiation (Alpha Org)
  const probC = await prisma.problem.create({
    data: {
      id: 'a0000000-0000-0000-0000-000000000003',
      organizationId: orgAlpha.id,
      code: 'PROB-C',
      title: 'Fast Exponentiation',
      description: 'Calculate (base ^ exp) modulo 1000000007.',
    },
  });

  const probCVer1 = await prisma.problemVersion.create({
    data: {
      problemId: probC.id,
      versionNumber: 1,
      timeLimitMs: 1000,
      memoryLimitMb: 128,
      statement: 'Given base and exp, compute base^exp % 1000000007 efficiently.',
    },
  });

  const probCSuite1 = await prisma.testSuiteVersion.create({
    data: {
      problemVersionId: probCVer1.id,
      versionNumber: 1,
      isAuthoritative: true,
    },
  });

  await prisma.testCase.createMany({
    data: [
      {
        testSuiteVersionId: probCSuite1.id,
        input: '2 10\n',
        expectedOutput: '1024\n',
        isSample: true,
        weight: 50,
        orderIndex: 0,
      },
      {
        testSuiteVersionId: probCSuite1.id,
        input: '3 100000000\n',
        expectedOutput: '688423210\n',
        isSample: false,
        weight: 50,
        orderIndex: 1,
      },
    ],
  });

  await prisma.problem.update({
    where: { id: probC.id },
    data: { currentVersionId: probCVer1.id },
  });

  // Attach Problems to Contest Alpha
  await prisma.contestProblem.createMany({
    data: [
      { contestId: contestAlpha.id, problemId: probA.id, alias: 'A', points: 100 },
      { contestId: contestAlpha.id, problemId: probB.id, alias: 'B', points: 100 },
      { contestId: contestAlpha.id, problemId: probC.id, alias: 'C', points: 100 },
    ],
  });

  console.log('--- Seed completed successfully ---');
  console.log('Organizations:');
  console.log(` - Alpha: ${orgAlpha.id} (slug: alpha-org)`);
  console.log(` - Beta:  ${orgBeta.id} (slug: beta-org)`);
  console.log('Contests:');
  console.log(` - Active Contest:    ${contestAlpha.id} (slug: alpha-round-1)`);
  console.log(` - Upcoming Contest:  ${contestBeta.id} (slug: beta-finals)`);
  console.log('Credentials for all users: email + "password123"');
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error('Seed failure:', e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
