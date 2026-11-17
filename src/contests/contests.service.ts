import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateContestDto, AttachProblemDto } from './dto/create-contest.dto';
import { PaginationQueryDto, PaginatedResult } from '../common/dto/pagination.dto';
import { ContestStatus } from '@prisma/client';
import { BusinessRuleException } from '../common/filters/http-exception.filter';

@Injectable()
export class ContestsService {
  constructor(private prisma: PrismaService) {}

  async createContest(organizationId: string, dto: CreateContestDto) {
    const start = new Date(dto.startTime);
    const end = new Date(dto.endTime);

    if (end <= start) {
      throw new BadRequestException('Contest endTime must be after startTime');
    }

    const existingSlug = await this.prisma.contest.findUnique({
      where: { slug: dto.slug },
    });
    if (existingSlug) {
      throw new ConflictException(`Contest with slug '${dto.slug}' already exists`);
    }

    const now = new Date();
    let initialStatus: ContestStatus = ContestStatus.UPCOMING;
    if (now >= start && now <= end) {
      initialStatus = ContestStatus.ACTIVE;
    } else if (now > end) {
      initialStatus = ContestStatus.COMPLETED;
    }

    return this.prisma.contest.create({
      data: {
        organizationId,
        title: dto.title,
        slug: dto.slug,
        description: dto.description,
        startTime: start,
        endTime: end,
        status: initialStatus,
        scoringRule: dto.scoringRule || 'ICPC',
        penaltyPerFailedAttemptSec: dto.penaltyPerFailedAttemptSec ?? 1200,
      },
    });
  }

  async listContests(query: PaginationQueryDto): Promise<PaginatedResult<any>> {
    const { skip, limit, order } = query;

    const [total, items] = await Promise.all([
      this.prisma.contest.count(),
      this.prisma.contest.findMany({
        skip,
        take: limit,
        orderBy: [{ startTime: order }, { id: 'desc' }],
        include: {
          organization: { select: { id: true, name: true, slug: true } },
          _count: { select: { participants: true, problems: true, submissions: true } },
        },
      }),
    ]);

    // Recalculate dynamic statuses based on wall-clock time
    const now = new Date();
    const data = items.map((contest) => {
      let dynamicStatus = contest.status;
      if (now < contest.startTime) {
        dynamicStatus = ContestStatus.UPCOMING;
      } else if (now >= contest.startTime && now <= contest.endTime) {
        dynamicStatus = ContestStatus.ACTIVE;
      } else {
        dynamicStatus = ContestStatus.COMPLETED;
      }
      return { ...contest, status: dynamicStatus };
    });

    return {
      data,
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

  async getContest(idOrSlug: string) {
    const contest = await this.prisma.contest.findFirst({
      where: {
        OR: [{ id: idOrSlug }, { slug: idOrSlug }],
      },
      include: {
        organization: { select: { id: true, name: true, slug: true } },
        problems: {
          include: {
            problem: {
              select: {
                id: true,
                code: true,
                title: true,
                description: true,
                currentVersionId: true,
              },
            },
          },
          orderBy: { alias: 'asc' },
        },
        _count: { select: { participants: true, submissions: true } },
      },
    });

    if (!contest) {
      throw new NotFoundException(`Contest '${idOrSlug}' not found`);
    }

    const now = new Date();
    let dynamicStatus = contest.status;
    if (now < contest.startTime) {
      dynamicStatus = ContestStatus.UPCOMING;
    } else if (now >= contest.startTime && now <= contest.endTime) {
      dynamicStatus = ContestStatus.ACTIVE;
    } else {
      dynamicStatus = ContestStatus.COMPLETED;
    }

    return { ...contest, status: dynamicStatus };
  }

  async registerParticipant(contestId: string, userId: string) {
    const contest = await this.getContest(contestId);

    // Cannot register for completed contest
    if (contest.status === ContestStatus.COMPLETED) {
      throw new BusinessRuleException('Cannot register for a completed contest');
    }

    const existing = await this.prisma.contestParticipant.findUnique({
      where: {
        contestId_userId: { contestId: contest.id, userId },
      },
    });

    if (existing) {
      return existing; // Idempotent registration
    }

    return this.prisma.contestParticipant.create({
      data: {
        contestId: contest.id,
        userId,
      },
    });
  }

  async attachProblem(contestId: string, dto: AttachProblemDto) {
    const contest = await this.prisma.contest.findUnique({ where: { id: contestId } });
    if (!contest) {
      throw new NotFoundException(`Contest ${contestId} not found`);
    }

    const problem = await this.prisma.problem.findUnique({ where: { id: dto.problemId } });
    if (!problem) {
      throw new NotFoundException(`Problem ${dto.problemId} not found`);
    }

    // Must belong to the same organization
    if (problem.organizationId !== contest.organizationId) {
      throw new BusinessRuleException(
        'Problem and Contest must belong to the same organization to be attached',
      );
    }

    return this.prisma.contestProblem.upsert({
      where: {
        contestId_problemId: {
          contestId,
          problemId: dto.problemId,
        },
      },
      update: {
        alias: dto.alias,
        points: dto.points ?? 100,
      },
      create: {
        contestId,
        problemId: dto.problemId,
        alias: dto.alias,
        points: dto.points ?? 100,
      },
    });
  }
}
