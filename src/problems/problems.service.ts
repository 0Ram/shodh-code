import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProblemDto, CreateProblemVersionDto } from './dto/create-problem.dto';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { OrgRole, GlobalRole } from '@prisma/client';

@Injectable()
export class ProblemsService {
  constructor(private prisma: PrismaService) {}

  async createProblem(organizationId: string, dto: CreateProblemDto) {
    const existing = await this.prisma.problem.findUnique({
      where: {
        organizationId_code: {
          organizationId,
          code: dto.code,
        },
      },
    });

    if (existing) {
      throw new ConflictException(
        `Problem with code '${dto.code}' already exists in organization ${organizationId}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Create logical problem
      const problem = await tx.problem.create({
        data: {
          organizationId,
          code: dto.code,
          title: dto.title,
          description: dto.statement.slice(0, 200),
        },
      });

      // 2. Create immutable Version 1
      const version = await tx.problemVersion.create({
        data: {
          problemId: problem.id,
          versionNumber: 1,
          timeLimitMs: dto.timeLimitMs ?? 2000,
          memoryLimitMb: dto.memoryLimitMb ?? 128,
          statement: dto.statement,
        },
      });

      // 3. Create immutable TestSuiteVersion 1
      const testSuite = await tx.testSuiteVersion.create({
        data: {
          problemVersionId: version.id,
          versionNumber: 1,
          isAuthoritative: true,
        },
      });

      // 4. Create Test Cases
      if (dto.testCases && dto.testCases.length > 0) {
        await tx.testCase.createMany({
          data: dto.testCases.map((tc, idx) => ({
            testSuiteVersionId: testSuite.id,
            input: tc.input,
            expectedOutput: tc.expectedOutput,
            isSample: tc.isSample ?? false,
            weight: tc.weight ?? 10,
            orderIndex: idx,
          })),
        });
      }

      // 5. Link current version to problem
      await tx.problem.update({
        where: { id: problem.id },
        data: { currentVersionId: version.id },
      });

      return {
        ...problem,
        currentVersion: {
          ...version,
          testSuiteVersion: testSuite,
        },
      };
    });
  }

  async createNewVersion(problemId: string, dto: CreateProblemVersionDto) {
    const problem = await this.prisma.problem.findUnique({
      where: { id: problemId },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });

    if (!problem) {
      throw new NotFoundException(`Problem ${problemId} not found`);
    }

    const nextVersionNumber = (problem.versions[0]?.versionNumber ?? 0) + 1;

    return this.prisma.$transaction(async (tx) => {
      // 1. Create new immutable version
      const version = await tx.problemVersion.create({
        data: {
          problemId: problem.id,
          versionNumber: nextVersionNumber,
          timeLimitMs: dto.timeLimitMs ?? 2000,
          memoryLimitMb: dto.memoryLimitMb ?? 128,
          statement: dto.statement,
        },
      });

      // 2. Create new TestSuiteVersion 1 for this problem version
      const testSuite = await tx.testSuiteVersion.create({
        data: {
          problemVersionId: version.id,
          versionNumber: 1,
          isAuthoritative: true,
        },
      });

      // 3. Create new Test Cases
      if (dto.testCases && dto.testCases.length > 0) {
        await tx.testCase.createMany({
          data: dto.testCases.map((tc, idx) => ({
            testSuiteVersionId: testSuite.id,
            input: tc.input,
            expectedOutput: tc.expectedOutput,
            isSample: tc.isSample ?? false,
            weight: tc.weight ?? 10,
            orderIndex: idx,
          })),
        });
      }

      // 4. Update currentVersionId on problem
      await tx.problem.update({
        where: { id: problem.id },
        data: { currentVersionId: version.id },
      });

      return {
        problemId: problem.id,
        newVersionNumber: nextVersionNumber,
        versionId: version.id,
        testSuiteVersionId: testSuite.id,
      };
    });
  }

  async getProblem(id: string, user?: AuthenticatedUser) {
    const problem = await this.prisma.problem.findUnique({
      where: { id },
      include: {
        organization: { select: { id: true, name: true, slug: true } },
        versions: {
          orderBy: { versionNumber: 'desc' },
          include: {
            testSuiteVersions: {
              include: {
                testCases: {
                  orderBy: { orderIndex: 'asc' },
                },
              },
            },
          },
        },
      },
    });

    if (!problem) {
      throw new NotFoundException(`Problem ${id} not found`);
    }

    // Determine if requester is an organizer in this organization
    const isSuperadmin = user?.globalRole === GlobalRole.SUPERADMIN;
    const isOrgOrganizer = user?.organizationMemberships?.some(
      (m) => m.organizationId === problem.organizationId && m.role === OrgRole.ORGANIZER,
    );
    const canSeeHidden = isSuperadmin || isOrgOrganizer;

    // Sanitize test cases if participant / non-organizer
    const sanitizedVersions = problem.versions.map((ver) => ({
      ...ver,
      testSuiteVersions: ver.testSuiteVersions.map((suite) => ({
        ...suite,
        testCases: suite.testCases
          .filter((tc) => (canSeeHidden ? true : tc.isSample))
          .map((tc) => (canSeeHidden ? tc : {
            id: tc.id,
            isSample: true,
            input: tc.input,
            expectedOutput: tc.expectedOutput,
            orderIndex: tc.orderIndex,
            weight: tc.weight,
          })),
      })),
    }));

    return {
      ...problem,
      versions: sanitizedVersions,
    };
  }

  async listContestProblems(contestId: string, user?: AuthenticatedUser) {
    const contestProblems = await this.prisma.contestProblem.findMany({
      where: { contestId },
      orderBy: { alias: 'asc' },
      include: {
        problem: {
          include: {
            versions: {
              orderBy: { versionNumber: 'desc' },
              take: 1,
              include: {
                testSuiteVersions: {
                  where: { isAuthoritative: true },
                  take: 1,
                  include: {
                    testCases: {
                      where: { isSample: true },
                      orderBy: { orderIndex: 'asc' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    return contestProblems.map((cp) => ({
      contestId: cp.contestId,
      alias: cp.alias,
      points: cp.points,
      problemId: cp.problem.id,
      code: cp.problem.code,
      title: cp.problem.title,
      description: cp.problem.description,
      currentVersion: cp.problem.versions[0] || null,
    }));
  }
}
