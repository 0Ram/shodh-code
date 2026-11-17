import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RunnerFactory } from './runner/runner.factory';
import { AppLoggerService } from '../common/logger/app-logger.service';
import { Verdict } from '@prisma/client';

export interface JudgeExecutionSummary {
  verdict: Verdict;
  score: number;
  maxExecutionTimeMs: number;
  maxMemoryUsageMb: number;
  testCasesPassed: number;
  totalTestCases: number;
  isInfrastructureError: boolean;
  errorDetails?: string;
  executionMode: 'docker' | 'subprocess';
}

@Injectable()
export class JudgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runnerFactory: RunnerFactory,
    private readonly logger: AppLoggerService,
  ) {}

  async evaluateSubmission(
    submissionId: string,
    attemptId: string,
    overrideMode?: 'docker' | 'subprocess',
    options?: { simulateRunnerCrash?: boolean },
  ): Promise<JudgeExecutionSummary> {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      include: {
        problemVersion: true,
        testSuiteVersion: {
          include: {
            testCases: { orderBy: { orderIndex: 'asc' } },
          },
        },
      },
    });

    if (!submission) {
      throw new Error(`Submission ${submissionId} not found for judging`);
    }

    const runner = this.runnerFactory.getRunner(overrideMode);
    const testCases = submission.testSuiteVersion.testCases;
    const timeLimitMs = submission.problemVersion.timeLimitMs;
    const memoryLimitMb = submission.problemVersion.memoryLimitMb;

    let totalScore = 0;
    let passedCount = 0;
    let maxTimeMs = 0;
    let maxMemoryMb = 0;
    let finalVerdict: Verdict = Verdict.ACCEPTED;
    let errorDetails: string | undefined = undefined;
    let isInfraError = false;

    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];
      const tcTimeLimit = tc.timeLimitMs || timeLimitMs;
      const tcMemoryLimit = tc.memoryLimitMb || memoryLimitMb;

      const execResult = await runner.execute({
        language: submission.language,
        sourceCode: submission.sourceCode,
        input: tc.input,
        timeLimitMs: tcTimeLimit,
        memoryLimitMb: tcMemoryLimit,
        simulateRunnerCrash: options?.simulateRunnerCrash,
      });

      maxTimeMs = Math.max(maxTimeMs, execResult.executionTimeMs);
      maxMemoryMb = Math.max(maxMemoryMb, execResult.memoryUsageMb);

      if (execResult.isInfrastructureError) {
        finalVerdict = Verdict.JUDGE_FAILURE;
        isInfraError = true;
        errorDetails = `Infrastructure runner failure: ${execResult.stderr}`;
        this.logger.error(
          `Judge infrastructure error on submission ${submissionId}`,
          execResult.stderr,
          'JudgeService',
          { submissionId, attemptId, executionMode: execResult.executionMode },
        );
        break;
      }

      if (execResult.isCompilationError) {
        finalVerdict = Verdict.COMPILATION_ERROR;
        errorDetails = `Compilation / Syntax Error: ${execResult.stderr.slice(0, 500)}`;
        break;
      }

      if (execResult.timedOut) {
        finalVerdict = Verdict.TIME_LIMIT_EXCEEDED;
        errorDetails = `Time limit exceeded on testcase #${i + 1}`;
        break;
      }

      if (execResult.outputTruncated) {
        finalVerdict = Verdict.OUTPUT_LIMIT_EXCEEDED;
        errorDetails = `Output limit exceeded on testcase #${i + 1}`;
        break;
      }

      if (execResult.exitCode !== 0) {
        finalVerdict = Verdict.RUNTIME_ERROR;
        errorDetails = `Runtime error on testcase #${i + 1}: ${execResult.stderr.slice(0, 500)}`;
        break;
      }

      // Output correctness check (strip trailing whitespace and normalize newlines)
      const actualOutput = execResult.stdout.replace(/\r\n/g, '\n').trimEnd();
      const expectedOutput = tc.expectedOutput.replace(/\r\n/g, '\n').trimEnd();

      if (actualOutput !== expectedOutput) {
        finalVerdict = Verdict.WRONG_ANSWER;
        errorDetails = `Wrong answer on testcase #${i + 1}`;
        break;
      }

      // Test case passed
      passedCount++;
      totalScore += tc.weight;
    }

    if (finalVerdict !== Verdict.ACCEPTED) {
      totalScore = 0; // For ICPC scoring, partial failures give 0 points
    }

    return {
      verdict: finalVerdict,
      score: totalScore,
      maxExecutionTimeMs: maxTimeMs,
      maxMemoryUsageMb: maxMemoryMb,
      testCasesPassed: passedCount,
      totalTestCases: testCases.length,
      isInfrastructureError: isInfraError,
      errorDetails,
      executionMode: runner.mode,
    };
  }
}
