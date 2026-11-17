import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import * as path from 'path';
import { ICodeRunner, ExecutionRequest, ExecutionResult } from './runner.interface';
import { AppLoggerService } from '../../common/logger/app-logger.service';

@Injectable()
export class SubprocessRunnerService implements ICodeRunner {
  readonly mode = 'subprocess' as const;
  private readonly scriptPath: string;

  constructor(private readonly logger: AppLoggerService) {
    this.scriptPath = path.resolve(process.cwd(), 'runner', 'execute.py');
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const memoryLimitMb = request.memoryLimitMb || 128;
    const timeLimitMs = request.timeLimitMs || 2000;
    const outputLimitBytes = request.outputLimitBytes || 65536;

    const payload = JSON.stringify({
      sourceCode: request.sourceCode,
      input: request.input,
      timeLimitMs,
      memoryLimitMb,
      outputLimitBytes,
      simulateRunnerCrash: request.simulateRunnerCrash,
      simulateHang: request.simulateHang,
    });

    return new Promise<ExecutionResult>((resolve) => {
      const startTime = Date.now();
      const child = spawn('python3', [this.scriptPath]);

      let stdoutData = '';
      let stderrData = '';
      let isSettled = false;

      const timeoutTimer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          try {
            child.kill('SIGKILL');
          } catch (e) {}
          resolve({
            exitCode: -1,
            timedOut: true,
            stdout: '',
            stderr: 'Execution timed out',
            executionTimeMs: Date.now() - startTime,
            memoryUsageMb: memoryLimitMb,
            outputTruncated: false,
            executionMode: 'subprocess',
          });
        }
      }, timeLimitMs + 1000);

      child.stdout.on('data', (chunk) => {
        stdoutData += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderrData += chunk.toString();
      });

      child.on('error', (err) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutTimer);
          resolve({
            exitCode: -1,
            timedOut: false,
            stdout: '',
            stderr: `Subprocess error: ${err.message}`,
            executionTimeMs: Date.now() - startTime,
            memoryUsageMb: 0,
            outputTruncated: false,
            executionMode: 'subprocess',
            isInfrastructureError: true,
          });
        }
      });

      child.on('close', (code) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutTimer);

          if (code === 71 || (code !== 0 && !stdoutData.trim())) {
            resolve({
              exitCode: code ?? -1,
              timedOut: false,
              stdout: '',
              stderr: stderrData || 'Subprocess runner infrastructure error',
              executionTimeMs: Date.now() - startTime,
              memoryUsageMb: 0,
              outputTruncated: false,
              executionMode: 'subprocess',
              isInfrastructureError: true,
            });
            return;
          }

          try {
            const parsed = JSON.parse(stdoutData.trim());
            resolve({
              exitCode: parsed.exitCode,
              isCompilationError: parsed.isCompilationError ?? false,
              timedOut: parsed.timedOut,
              stdout: parsed.stdout,
              stderr: parsed.stderr,
              executionTimeMs: parsed.executionTimeMs,
              memoryUsageMb: parsed.memoryUsageMb,
              outputTruncated: parsed.outputTruncated,
              executionMode: 'subprocess',
            });
          } catch (e) {
            resolve({
              exitCode: code ?? -1,
              timedOut: false,
              stdout: stdoutData,
              stderr: stderrData || 'Failed to parse subprocess output',
              executionTimeMs: Date.now() - startTime,
              memoryUsageMb: 0,
              outputTruncated: false,
              executionMode: 'subprocess',
              isInfrastructureError: true,
            });
          }
        }
      });

      try {
        child.stdin.write(payload);
        child.stdin.end();
      } catch (err) {}
    });
  }
}
