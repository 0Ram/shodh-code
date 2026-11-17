import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSubmissionDto, RejudgeSubmissionDto } from './dto/create-submission.dto';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PaginationQueryDto, PaginatedResult } from '../common/dto/pagination.dto';
import { computeRequestHash, generateFencingToken } from '../common/utils/hash.util';
import { BusinessRuleException } from '../common/filters/http-exception.filter';
import { ContestStatus, SubmissionStatus, Verdict, OrgRole, GlobalRole, JobStatus } from '@prisma/client';

@Injectable()
export class SubmissionsService {
  constructor(private prisma: PrismaService) {}

  async createSubmission(
    contestId: string,
    user: AuthenticatedUser,
    dto: CreateSubmissionDto,
    headerIdempotencyKey?: string,
  ) {
    const idempotencyKey = headerIdempotencyKey || dto.idempotencyKey;

    // 1. Verify contest existence and active timing
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
    });
    if (!contest) {
      throw new NotFoundException(`Contest ${contestId} not found`);
    }

    const now = new Date();
    if (now < contest.startTime || now > contest.endTime || contest.status === ContestStatus.COMPLETED) {
      throw new BusinessRuleException(
        `Contest '${contest.title}' is not active for submissions. Window: ${contest.startTime.toISOString()} - ${contest.endTime.toISOString()}`,
      );
    }

    // 2. Verify participant registration
    const participant = await this.prisma.contestParticipant.findUnique({
      where: {
        contestId_userId: {
          contestId,
          userId: user.id,
        },
      },
    });
    if (!participant) {
      throw new BusinessRuleException(
        'Participant must register for the contest prior to submitting code',
      );
    }

    // 3. Verify problem is attached to this contest
    const contestProblem = await this.prisma.contestProblem.findUnique({
      where: {
        contestId_problemId: {
          contestId,
          problemId: dto.problemId,
        },
      },
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
                },
              },
            },
          },
        },
      },
    });

    if (!contestProblem) {
      throw new NotFoundException(`Problem ${dto.problemId} is not part of contest ${contestId}`);
    }

    const currentVersion = contestProblem.problem.versions[0];
    if (!currentVersion) {
      throw new BusinessRuleException('Problem has no configured version');
    }

    const testSuiteVersion = currentVersion.testSuiteVersions[0];
    if (!testSuiteVersion) {
      throw new BusinessRuleException('Problem version has no active test-suite version');
    }

    // 4. Idempotency Check
    const requestPayloadToHash = {
      problemId: dto.problemId,
      language: dto.language,
      sourceCode: dto.sourceCode,
    };
    const requestHash = computeRequestHash(requestPayloadToHash);

    if (idempotencyKey) {
      const existingIdemRecord = await this.prisma.idempotencyRecord.findUnique({
        where: {
          idempotencyKey_actorId_contestId: {
            idempotencyKey,
            actorId: user.id,
            contestId,
          },
        },
      });

      if (existingIdemRecord) {
        if (existingIdemRecord.requestHash === requestHash) {
          // Exact replay of identical request -> return existing submission
          const existingSubmission = await this.prisma.submission.findUnique({
            where: { id: existingIdemRecord.submissionId },
          });
          if (existingSubmission) {
            return {
              ...existingSubmission,
              isIdempotentReplay: true,
            };
          }
        } else {
          // Key reused with conflicting payload -> HTTP 409 Conflict
          throw new ConflictException(
            `Idempotency key '${idempotencyKey}' was already used with a different request payload in contest ${contestId}`,
          );
        }
      }
    }

    // 5. Transaction Boundary: Persist Submission + Initial Attempt + JudgeJob + OutboxEvent
    try {
      return await this.prisma.$transaction(async (tx) => {
        const submission = await tx.submission.create({
          data: {
            contestId,
            problemId: dto.problemId,
            problemVersionId: currentVersion.id,
            testSuiteVersionId: testSuiteVersion.id,
            userId: user.id,
            language: dto.language,
            sourceCode: dto.sourceCode,
            status: SubmissionStatus.QUEUED,
            verdict: Verdict.PENDING,
            score: 0,
          },
        });

        const fencingToken = generateFencingToken();

        const attempt = await tx.submissionAttempt.create({
          data: {
            submissionId: submission.id,
            attemptNumber: 1,
            fencingToken,
            status: SubmissionStatus.QUEUED,
            verdict: Verdict.PENDING,
            isAuthoritative: true,
            problemVersionId: currentVersion.id,
            testSuiteVersionId: testSuiteVersion.id,
          },
        });

        // Update submission authoritativeAttemptId
        await tx.submission.update({
          where: { id: submission.id },
          data: { authoritativeAttemptId: attempt.id },
        });

        const job = await tx.judgeJob.create({
          data: {
            submissionId: submission.id,
            attemptId: attempt.id,
            status: JobStatus.QUEUED,
            priority: 0,
          },
        });

        // Transactional Outbox Event
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'SUBMISSION',
            aggregateId: submission.id,
            eventType: 'SUBMISSION_CREATED',
            payload: {
              submissionId: submission.id,
              attemptId: attempt.id,
              jobId: job.id,
            },
          },
        });

        if (idempotencyKey) {
          await tx.idempotencyRecord.create({
            data: {
              idempotencyKey,
              actorId: user.id,
              contestId,
              requestHash,
              submissionId: submission.id,
            },
          });
        }

        return {
          id: submission.id,
          contestId: submission.contestId,
          problemId: submission.problemId,
          problemVersionId: submission.problemVersionId,
          status: submission.status,
          verdict: submission.verdict,
          submittedAt: submission.submittedAt,
          attemptNumber: 1,
          isIdempotentReplay: false,
        };
      });
    } catch (err: any) {
      if (idempotencyKey && (err.code === 'P2002' || err.message?.includes('Unique constraint failed'))) {
        const raceRecord = await this.prisma.idempotencyRecord.findUnique({
          where: {
            idempotencyKey_actorId_contestId: {
              idempotencyKey,
              actorId: user.id,
              contestId,
            },
          },
        });
        if (raceRecord) {
          if (raceRecord.requestHash === requestHash) {
            const existing = await this.prisma.submission.findUnique({
              where: { id: raceRecord.submissionId },
            });
            if (existing) {
              return {
                ...existing,
                isIdempotentReplay: true,
              };
            }
          } else {
            throw new ConflictException(
              `Idempotency key '${idempotencyKey}' was already used with a different request payload in contest ${contestId}`,
            );
          }
        }
      }
      throw err;
    }
  }

  async getSubmission(id: string, user: AuthenticatedUser) {
    const submission = await this.prisma.submission.findUnique({
      where: { id },
      include: {
        contest: { select: { id: true, title: true, organizationId: true } },
        problem: { select: { id: true, code: true, title: true } },
        problemVersion: { select: { id: true, versionNumber: true, timeLimitMs: true, memoryLimitMb: true } },
        attempts: {
          orderBy: { attemptNumber: 'desc' },
          select: {
            id: true,
            attemptNumber: true,
            status: true,
            verdict: true,
            score: true,
            executionTimeMs: true,
            memoryUsageMb: true,
            isAuthoritative: true,
            isRejudge: true,
            finishedAt: true,
            errorDetails: true,
          },
        },
      },
    });

    if (!submission) {
      throw new NotFoundException(`Submission ${id} not found`);
    }

    // Authorization Boundary Check
    const isOwner = submission.userId === user.id;
    const isSuperadmin = user.globalRole === GlobalRole.SUPERADMIN;
    const isOrgOrganizer = user.organizationMemberships?.some(
      (m) => m.organizationId === submission.contest.organizationId && m.role === OrgRole.ORGANIZER,
    );

    if (!isOwner && !isSuperadmin && !isOrgOrganizer) {
      throw new ForbiddenException('Access denied: Cannot read private submission of another participant');
    }

    // If participant is reading, mask private code if requested or error details if needed
    return {
      ...submission,
      // Source code is visible to owner and organizer, hidden from others
      sourceCode: isOwner || isOrgOrganizer || isSuperadmin ? submission.sourceCode : undefined,
    };
  }

  async listSubmissions(
    contestId: string,
    query: PaginationQueryDto,
    user: AuthenticatedUser,
  ): Promise<PaginatedResult<any>> {
    const contest = await this.prisma.contest.findUnique({ where: { id: contestId } });
    if (!contest) {
      throw new NotFoundException(`Contest ${contestId} not found`);
    }

    const isOrgOrganizer =
      user.globalRole === GlobalRole.SUPERADMIN ||
      user.organizationMemberships?.some(
        (m) => m.organizationId === contest.organizationId && m.role === OrgRole.ORGANIZER,
      );

    // If organizer: can see all submissions in contest. If participant: only sees own submissions!
    const whereClause: any = { contestId };
    if (!isOrgOrganizer) {
      whereClause.userId = user.id;
    }

    const { skip, limit, order } = query;

    const [total, items] = await Promise.all([
      this.prisma.submission.count({ where: whereClause }),
      this.prisma.submission.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: [{ createdAt: order }, { id: 'desc' }],
        include: {
          problem: { select: { id: true, code: true, title: true } },
          user: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    return {
      data: items,
      meta: {
        total,
        page: query.page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: skip + limit < total,
        hasPrevPage: query.page > 1,
      },
    };
  }

  async rejudgeSubmission(
    submissionId: string,
    user: AuthenticatedUser,
    dto: RejudgeSubmissionDto,
  ) {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      include: {
        contest: true,
        attempts: { orderBy: { attemptNumber: 'desc' } },
      },
    });

    if (!submission) {
      throw new NotFoundException(`Submission ${submissionId} not found`);
    }

    // Role boundary: only organizer or superadmin can rejudge
    const isOrganizer =
      user.globalRole === GlobalRole.SUPERADMIN ||
      user.organizationMemberships?.some(
        (m) => m.organizationId === submission.contest.organizationId && m.role === OrgRole.ORGANIZER,
      );

    if (!isOrganizer) {
      throw new ForbiddenException('Only contest organizers can trigger submission rejudging');
    }

    const targetProblemVersionId = dto.problemVersionId || submission.problemVersionId;
    let targetTestSuiteVersionId = dto.testSuiteVersionId;

    if (!targetTestSuiteVersionId) {
      const suite = await this.prisma.testSuiteVersion.findFirst({
        where: { problemVersionId: targetProblemVersionId, isAuthoritative: true },
      });
      if (!suite) {
        throw new NotFoundException('Authoritative test suite version not found for problem version');
      }
      targetTestSuiteVersionId = suite.id;
    }

    const nextAttemptNumber = (submission.attempts[0]?.attemptNumber ?? 0) + 1;
    const fencingToken = generateFencingToken();

    return this.prisma.$transaction(async (tx) => {
      const attempt = await tx.submissionAttempt.create({
        data: {
          submissionId: submission.id,
          attemptNumber: nextAttemptNumber,
          fencingToken,
          status: SubmissionStatus.QUEUED,
          verdict: Verdict.PENDING,
          isAuthoritative: false, // will become authoritative upon completion
          isRejudge: true,
          problemVersionId: targetProblemVersionId,
          testSuiteVersionId: targetTestSuiteVersionId,
        },
      });

      await tx.submission.update({
        where: { id: submission.id },
        data: {
          status: SubmissionStatus.QUEUED,
          problemVersionId: targetProblemVersionId,
          testSuiteVersionId: targetTestSuiteVersionId,
        },
      });

      const job = await tx.judgeJob.create({
        data: {
          submissionId: submission.id,
          attemptId: attempt.id,
          status: JobStatus.QUEUED,
          priority: 10, // Rejudge gets higher priority
        },
      });

      await tx.outboxEvent.create({
        data: {
          aggregateType: 'REJUDGE',
          aggregateId: submission.id,
          eventType: 'REJUDGE_REQUESTED',
          payload: {
            submissionId: submission.id,
            attemptId: attempt.id,
            jobId: job.id,
          },
        },
      });

      return {
        submissionId: submission.id,
        attemptId: attempt.id,
        attemptNumber: nextAttemptNumber,
        status: SubmissionStatus.QUEUED,
        message: 'Rejudging job enqueued successfully',
      };
    });
  }
}
