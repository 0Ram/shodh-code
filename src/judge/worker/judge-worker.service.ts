import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JudgeService } from '../judge.service';
import { AppLoggerService } from '../../common/logger/app-logger.service';
import { JobStatus, SubmissionStatus, Verdict } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class JudgeWorkerService implements OnModuleInit, OnModuleDestroy {
  readonly workerId: string;
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private leaseDurationSec = 15;
  private maxRetries = 3;
  private pollIntervalMs = 300;

  constructor(
    private readonly prisma: PrismaService,
    private readonly judgeService: JudgeService,
    private readonly logger: AppLoggerService,
  ) {
    this.workerId = `worker-${process.env.WORKER_NAME || 'default'}-${uuidv4().slice(0, 8)}`;
    this.leaseDurationSec = parseInt(process.env.WORKER_LEASE_DURATION_SEC || '15', 10);
    this.maxRetries = parseInt(process.env.WORKER_MAX_RETRIES || '3', 10);
    this.pollIntervalMs = parseInt(process.env.WORKER_POLL_INTERVAL_MS || '300', 10);
  }

  async onModuleInit() {
    this.logger.log(`Initialized judge worker: ${this.workerId}`, 'JudgeWorker');
  }

  async onModuleDestroy() {
    await this.stop();
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.log(`Starting continuous processing loop for ${this.workerId}`, 'JudgeWorker');
    this.loop();
  }

  async stop() {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.logger.log(`Stopped worker ${this.workerId}`, 'JudgeWorker');
  }

  private async loop() {
    if (!this.isRunning) return;

    try {
      // 1. Recover abandoned or expired leases first
      await this.recoverAbandonedJobs();

      // 2. Process available queued jobs
      const processed = await this.claimAndProcessNextJob();
      if (!processed) {
        // Sleep if no work
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      }
    } catch (err: any) {
      this.logger.error(`Error in worker processing loop: ${err.message}`, err.stack, 'JudgeWorker');
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (this.isRunning) {
      setImmediate(() => this.loop());
    }
  }

  /**
   * Atomic Job Claiming using PostgreSQL 'FOR UPDATE SKIP LOCKED'.
   * Ensures competing workers cannot claim or process the same job.
   */
  async claimAndProcessNextJob(simulateRunnerCrash = false): Promise<boolean> {
    const leaseDuration = this.leaseDurationSec;
    const workerId = this.workerId;

    // Transactional claim
    const claimedJob = await this.prisma.$transaction(async (tx) => {
      const rawJobs = await tx.$queryRaw<Array<{ id: string; submissionId: string; attemptId: string; retryCount: number }>>`
        SELECT "id", "submissionId", "attemptId", "retryCount"
        FROM "JudgeJob"
        WHERE "status" = 'QUEUED' OR ("status" = 'RETRYABLE' AND "leaseExpiresAt" <= NOW())
        ORDER BY "priority" DESC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1;
      `;

      if (!rawJobs || rawJobs.length === 0) {
        return null;
      }

      const job = rawJobs[0];
      const leaseExpiresAt = new Date(Date.now() + leaseDuration * 1000);

      // Transition job to LEASED
      await tx.judgeJob.update({
        where: { id: job.id },
        data: {
          status: JobStatus.LEASED,
          claimedBy: workerId,
          leaseExpiresAt,
          retryCount: { increment: 1 },
          lastHeartbeatAt: new Date(),
        },
      });

      // Transition submission and attempt to RUNNING
      await tx.submissionAttempt.update({
        where: { id: job.attemptId },
        data: {
          status: SubmissionStatus.RUNNING,
          startedAt: new Date(),
          workerId,
        },
      });

      await tx.submission.update({
        where: { id: job.submissionId },
        data: { status: SubmissionStatus.RUNNING },
      });

      return job;
    });

    if (!claimedJob) {
      return false;
    }

    this.logger.log(
      `Worker ${workerId} acquired lease on job ${claimedJob.id} for submission ${claimedJob.submissionId}`,
      'JudgeWorker',
      { jobId: claimedJob.id, submissionId: claimedJob.submissionId, attemptId: claimedJob.attemptId },
    );

    await this.processClaimedJob(claimedJob.id, claimedJob.submissionId, claimedJob.attemptId, simulateRunnerCrash);
    return true;
  }

  private async processClaimedJob(
    jobId: string,
    submissionId: string,
    attemptId: string,
    simulateRunnerCrash = false,
  ) {
    try {
      // Execute the judge evaluation
      const summary = await this.judgeService.evaluateSubmission(
        submissionId,
        attemptId,
        undefined,
        { simulateRunnerCrash },
      );

      // Handle Infrastructure Failure (Controllable runner crash or host issue)
      if (summary.isInfrastructureError) {
        await this.handleInfrastructureFailure(jobId, submissionId, attemptId, summary.errorDetails);
        return;
      }

      // Finalize Result with Attempt Fencing
      await this.finalizeAttemptWithFencing(jobId, submissionId, attemptId, summary);
    } catch (err: any) {
      this.logger.error(
        `Unexpected error processing job ${jobId}: ${err.message}`,
        err.stack,
        'JudgeWorker',
        { jobId, submissionId, attemptId },
      );
      await this.handleInfrastructureFailure(jobId, submissionId, attemptId, err.message);
    }
  }

  /**
   * Attempt Fencing & Atomic Authoritative Result Application.
   * Competing or delayed workers from older attempts are fenced off.
   */
  private async finalizeAttemptWithFencing(
    jobId: string,
    submissionId: string,
    attemptId: string,
    summary: any,
  ) {
    await this.prisma.$transaction(async (tx) => {
      // 1. Fetch current target attempt and submission with lock
      const attempt = await tx.submissionAttempt.findUnique({
        where: { id: attemptId },
      });
      const submission = await tx.submission.findUnique({
        where: { id: submissionId },
        include: { contest: true },
      });

      if (!attempt || !submission) {
        throw new Error('Attempt or submission not found during finalization');
      }

      // Check current authoritative attempt if one exists
      const authoritativeAttempt = submission.authoritativeAttemptId
        ? await tx.submissionAttempt.findUnique({ where: { id: submission.authoritativeAttemptId } })
        : null;

      const isStale =
        authoritativeAttempt &&
        authoritativeAttempt.id !== attempt.id &&
        attempt.fencingToken < authoritativeAttempt.fencingToken;

      const finishedAt = new Date();

      if (isStale) {
        // Stale attempt: newer rejudge attempt has already taken precedence!
        // We persist the diagnostic verdict on this attempt but DO NOT update authoritative submission verdict
        await tx.submissionAttempt.update({
          where: { id: attemptId },
          data: {
            status: SubmissionStatus.COMPLETED,
            verdict: summary.verdict,
            score: summary.score,
            executionTimeMs: summary.maxExecutionTimeMs,
            memoryUsageMb: summary.maxMemoryUsageMb,
            finishedAt,
            isAuthoritative: false, // Fenced off!
            errorDetails: summary.errorDetails,
          },
        });

        await tx.judgeJob.update({
          where: { id: jobId },
          data: { status: JobStatus.COMPLETED },
        });

        this.logger.warn(
          `Fenced off older attempt ${attempt.attemptNumber} (token ${attempt.fencingToken}) for submission ${submissionId}`,
          'JudgeWorker',
          { submissionId, attemptId },
        );
        return;
      }

      // The attempt is AUTHORITATIVE
      // Demote any previously authoritative attempt
      await tx.submissionAttempt.updateMany({
        where: { submissionId, isAuthoritative: true },
        data: { isAuthoritative: false },
      });

      // Mark this attempt as authoritative
      await tx.submissionAttempt.update({
        where: { id: attemptId },
        data: {
          status: SubmissionStatus.COMPLETED,
          verdict: summary.verdict,
          score: summary.score,
          executionTimeMs: summary.maxExecutionTimeMs,
          memoryUsageMb: summary.maxMemoryUsageMb,
          finishedAt,
          isAuthoritative: true,
          errorDetails: summary.errorDetails,
        },
      });

      // Update submission authoritative state
      await tx.submission.update({
        where: { id: submissionId },
        data: {
          status: SubmissionStatus.COMPLETED,
          verdict: summary.verdict,
          score: summary.score,
          maxExecutionTimeMs: summary.maxExecutionTimeMs,
          maxMemoryUsageMb: summary.maxMemoryUsageMb,
          authoritativeAttemptId: attemptId,
          completedAt: finishedAt,
        },
      });

      // Update Job status
      await tx.judgeJob.update({
        where: { id: jobId },
        data: { status: JobStatus.COMPLETED },
      });

      // Update Standings / Leaderboard Row transactionally
      await this.updateLeaderboardForSubmission(tx, submission.contestId, submission.userId);
    });

    this.logger.log(
      `Job ${jobId} successfully completed with verdict ${summary.verdict} for submission ${submissionId}`,
      'JudgeWorker',
      { jobId, submissionId, attemptId, verdict: summary.verdict, score: summary.score },
    );
  }

  private async handleInfrastructureFailure(
    jobId: string,
    submissionId: string,
    attemptId: string,
    errorDetails?: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const job = await tx.judgeJob.findUnique({ where: { id: jobId } });
      if (!job) return;

      if (job.retryCount < this.maxRetries) {
        // Mark as RETRYABLE with backoff
        const backoffSeconds = Math.pow(2, job.retryCount);
        const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000);

        await tx.judgeJob.update({
          where: { id: jobId },
          data: {
            status: JobStatus.RETRYABLE,
            leaseExpiresAt: nextAttemptAt,
            claimedBy: null,
          },
        });

        await tx.submissionAttempt.update({
          where: { id: attemptId },
          data: {
            errorDetails: `Infrastructure failure (retry #${job.retryCount}): ${errorDetails}`,
          },
        });

        this.logger.warn(
          `Job ${jobId} encountered runner failure. Scheduled retry #${job.retryCount} at ${nextAttemptAt.toISOString()}`,
          'JudgeWorker',
          { jobId, submissionId, attemptId, retryCount: job.retryCount },
        );
      } else {
        // Retries exhausted: mark as FAILED with JUDGE_FAILURE without blaming student
        await tx.judgeJob.update({
          where: { id: jobId },
          data: { status: JobStatus.FAILED },
        });

        await tx.submissionAttempt.update({
          where: { id: attemptId },
          data: {
            status: SubmissionStatus.FAILED,
            verdict: Verdict.JUDGE_FAILURE,
            errorDetails: `Judge infrastructure exhausted retries: ${errorDetails}`,
            finishedAt: new Date(),
          },
        });

        await tx.submission.update({
          where: { id: submissionId },
          data: {
            status: SubmissionStatus.FAILED,
            verdict: Verdict.JUDGE_FAILURE,
            completedAt: new Date(),
          },
        });

        this.logger.error(
          `Job ${jobId} failed permanently due to infrastructure failure after ${this.maxRetries} retries`,
          errorDetails,
          'JudgeWorker',
          { jobId, submissionId, attemptId },
        );
      }
    });
  }

  /**
   * Abandoned work recovery: picks up jobs leased by workers that crashed or timed out.
   */
  async recoverAbandonedJobs(): Promise<number> {
    const now = new Date();
    const expiredJobs = await this.prisma.judgeJob.findMany({
      where: {
        status: JobStatus.LEASED,
        leaseExpiresAt: { lt: now },
      },
      take: 10,
    });

    if (expiredJobs.length === 0) return 0;

    for (const job of expiredJobs) {
      await this.prisma.$transaction(async (tx) => {
        if (job.retryCount < this.maxRetries) {
          await tx.judgeJob.update({
            where: { id: job.id },
            data: {
              status: JobStatus.QUEUED,
              claimedBy: null,
              leaseExpiresAt: null,
            },
          });
          this.logger.warn(`Recovered abandoned job ${job.id} from crashed worker ${job.claimedBy}`, 'JudgeWorker');
        } else {
          await tx.judgeJob.update({
            where: { id: job.id },
            data: { status: JobStatus.FAILED },
          });
          await tx.submission.update({
            where: { id: job.submissionId },
            data: { status: SubmissionStatus.FAILED, verdict: Verdict.JUDGE_FAILURE },
          });
        }
      });
    }

    return expiredJobs.length;
  }

  /**
   * Recalculate leaderboard row for a specific participant in contest.
   */
  private async updateLeaderboardForSubmission(tx: any, contestId: string, userId: string) {
    const contest = await tx.contest.findUnique({ where: { id: contestId } });
    if (!contest) return;

    // Fetch all authoritative submissions of this user in this contest
    const userSubmissions = await tx.submission.findMany({
      where: {
        contestId,
        userId,
        status: SubmissionStatus.COMPLETED,
      },
      include: {
        contest: true,
      },
      orderBy: { submittedAt: 'asc' },
    });

    // Group by problemId
    const problemMap: Record<
      string,
      { solved: boolean; failedAttemptsBeforeSolve: number; acceptedTimeSec: number; score: number }
    > = {};

    let totalScore = 0;
    let problemsSolved = 0;
    let totalPenaltySec = 0;
    let lastAcceptedAt: Date | null = null;

    const penaltyPerFailed = contest.penaltyPerFailedAttemptSec || 1200;

    for (const sub of userSubmissions) {
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
        // Submissions after already solved do not alter penalty in ICPC
        continue;
      }

      if (sub.verdict === Verdict.ACCEPTED) {
        problemMap[pId].solved = true;
        const contestStartMs = contest.startTime.getTime();
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
        // Failed attempt prior to solve adds to penalty count
        problemMap[pId].failedAttemptsBeforeSolve++;
      }
    }

    // Upsert LeaderboardRow
    await tx.leaderboardRow.upsert({
      where: {
        contestId_userId: { contestId, userId },
      },
      update: {
        score: totalScore,
        penaltyTimeSec: totalPenaltySec,
        problemsSolved,
        detailJson: problemMap,
        lastAcceptedAt,
      },
      create: {
        contestId,
        userId,
        score: totalScore,
        penaltyTimeSec: totalPenaltySec,
        problemsSolved,
        detailJson: problemMap,
        lastAcceptedAt,
      },
    });

    // Re-rank participants in this contest
    const allRows = await tx.leaderboardRow.findMany({
      where: { contestId },
      orderBy: [
        { score: 'desc' },
        { penaltyTimeSec: 'asc' },
        { lastAcceptedAt: 'asc' },
        { userId: 'asc' },
      ],
    });

    for (let i = 0; i < allRows.length; i++) {
      const rank = i + 1;
      if (allRows[i].rank !== rank) {
        await tx.leaderboardRow.update({
          where: { id: allRows[i].id },
          data: { rank },
        });
      }
    }
  }
}
