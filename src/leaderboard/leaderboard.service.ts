import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderboardQueryDto } from './dto/leaderboard-query.dto';
import { PaginatedResult } from '../common/dto/pagination.dto';
import { SubmissionStatus, Verdict } from '@prisma/client';

@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getLeaderboard(
    contestId: string,
    query: LeaderboardQueryDto,
  ): Promise<PaginatedResult<any>> {
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
    });
    if (!contest) {
      throw new NotFoundException(`Contest ${contestId} not found`);
    }

    const { skip, limit } = query;

    const [total, rows] = await Promise.all([
      this.prisma.leaderboardRow.count({ where: { contestId } }),
      this.prisma.leaderboardRow.findMany({
        where: { contestId },
        skip,
        take: limit,
        orderBy: [{ rank: 'asc' }, { userId: 'asc' }],
      }),
    ]);

    // Fetch user profiles for the rows
    const userIds = rows.map((r) => r.userId);
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    const enrichedData = rows.map((row) => ({
      ...row,
      user: userMap.get(row.userId) || { id: row.userId, name: 'Unknown', email: '' },
    }));

    return {
      data: enrichedData,
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

  /**
   * Rebuilds standings strictly from scratch using only authoritative submissions and attempts.
   * Compares the rebuilt result with current serving path to verify absolute data consistency.
   */
  async rebuildStandings(contestId: string) {
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
    });
    if (!contest) {
      throw new NotFoundException(`Contest ${contestId} not found`);
    }

    const penaltyPerFailed = contest.penaltyPerFailedAttemptSec || 1200;
    const contestStartMs = contest.startTime.getTime();

    // Fetch all completed submissions with authoritative attempts
    const completedSubmissions = await this.prisma.submission.findMany({
      where: {
        contestId,
        status: SubmissionStatus.COMPLETED,
      },
      orderBy: { submittedAt: 'asc' },
    });

    // Group by participant
    const userMap: Record<string, typeof completedSubmissions> = {};
    for (const sub of completedSubmissions) {
      if (!userMap[sub.userId]) {
        userMap[sub.userId] = [];
      }
      userMap[sub.userId].push(sub);
    }

    const rebuiltStandings: Array<{
      userId: string;
      score: number;
      problemsSolved: number;
      penaltyTimeSec: number;
      lastAcceptedAt: Date | null;
      detailJson: any;
    }> = [];

    for (const [userId, submissions] of Object.entries(userMap)) {
      const problemMap: Record<
        string,
        { solved: boolean; failedAttemptsBeforeSolve: number; acceptedTimeSec: number; score: number }
      > = {};

      let totalScore = 0;
      let problemsSolved = 0;
      let totalPenaltySec = 0;
      let lastAcceptedAt: Date | null = null;

      for (const sub of submissions) {
        const pId = sub.problemId;
        if (!problemMap[pId]) {
          problemMap[pId] = {
            solved: false,
            failedAttemptsBeforeSolve: 0,
            acceptedTimeSec: 0,
            score: 0,
          };
        }

        if (problemMap[pId].solved) {
          continue;
        }

        if (sub.verdict === Verdict.ACCEPTED) {
          problemMap[pId].solved = true;
          const subTimeMs = sub.submittedAt.getTime();
          const timeFromStartSec = Math.max(0, Math.floor((subTimeMs - contestStartMs) / 1000));

          problemMap[pId].acceptedTimeSec = timeFromStartSec;
          problemMap[pId].score = 100;

          problemsSolved++;
          totalScore += 100;
          totalPenaltySec += timeFromStartSec + problemMap[pId].failedAttemptsBeforeSolve * penaltyPerFailed;

          if (!lastAcceptedAt || sub.submittedAt > lastAcceptedAt) {
            lastAcceptedAt = sub.submittedAt;
          }
        } else if (
          sub.verdict === Verdict.WRONG_ANSWER ||
          sub.verdict === Verdict.RUNTIME_ERROR ||
          sub.verdict === Verdict.TIME_LIMIT_EXCEEDED ||
          sub.verdict === Verdict.MEMORY_LIMIT_EXCEEDED ||
          sub.verdict === Verdict.OUTPUT_LIMIT_EXCEEDED
        ) {
          problemMap[pId].failedAttemptsBeforeSolve++;
        }
      }

      rebuiltStandings.push({
        userId,
        score: totalScore,
        problemsSolved,
        penaltyTimeSec: totalPenaltySec,
        lastAcceptedAt,
        detailJson: problemMap,
      });
    }

    // Sort according to deterministic ICPC rules
    rebuiltStandings.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.penaltyTimeSec !== b.penaltyTimeSec) return a.penaltyTimeSec - b.penaltyTimeSec;
      if (a.lastAcceptedAt && b.lastAcceptedAt) {
        if (a.lastAcceptedAt.getTime() !== b.lastAcceptedAt.getTime()) {
          return a.lastAcceptedAt.getTime() - b.lastAcceptedAt.getTime();
        }
      } else if (a.lastAcceptedAt) return -1;
      else if (b.lastAcceptedAt) return 1;
      return a.userId.localeCompare(b.userId);
    });

    // Check serving path records prior to update
    const existingServingRows = await this.prisma.leaderboardRow.findMany({
      where: { contestId },
      orderBy: [{ rank: 'asc' }, { userId: 'asc' }],
    });

    // Write atomic updates
    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < rebuiltStandings.length; i++) {
        const item = rebuiltStandings[i];
        const rank = i + 1;
        await tx.leaderboardRow.upsert({
          where: { contestId_userId: { contestId, userId: item.userId } },
          update: {
            rank,
            score: item.score,
            problemsSolved: item.problemsSolved,
            penaltyTimeSec: item.penaltyTimeSec,
            lastAcceptedAt: item.lastAcceptedAt,
            detailJson: item.detailJson,
          },
          create: {
            contestId,
            userId: item.userId,
            rank,
            score: item.score,
            problemsSolved: item.problemsSolved,
            penaltyTimeSec: item.penaltyTimeSec,
            lastAcceptedAt: item.lastAcceptedAt,
            detailJson: item.detailJson,
          },
        });
      }
    });

    // Verify consistency: serving path matches rebuilt standings exactly
    const isConsistent =
      existingServingRows.length === rebuiltStandings.length &&
      existingServingRows.every((row, idx) => {
        const rebuilt = rebuiltStandings[idx];
        return (
          row.userId === rebuilt.userId &&
          row.score === rebuilt.score &&
          row.penaltyTimeSec === rebuilt.penaltyTimeSec
        );
      });

    return {
      contestId,
      totalParticipantsRanked: rebuiltStandings.length,
      isConsistentWithPreviousServingPath: isConsistent,
      standings: rebuiltStandings.map((s, idx) => ({
        rank: idx + 1,
        ...s,
      })),
    };
  }
}
