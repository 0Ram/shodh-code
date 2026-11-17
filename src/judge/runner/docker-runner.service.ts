import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import { ICodeRunner, ExecutionRequest, ExecutionResult } from './runner.interface';
import { AppLoggerService } from '../../common/logger/app-logger.service';

@Injectable()
export class DockerRunnerService implements ICodeRunner {
  readonly mode = 'docker' as const;
  private readonly dockerImage: string;

  constructor(private readonly logger: AppLoggerService) {
    this.dockerImage = process.env.RUNNER_DOCKER_IMAGE || 'shodh-runner:latest';
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const memoryLimitMb = request.memoryLimitMb || 128;
    const timeLimitMs = request.timeLimitMs || 2000;
    const outputLimitBytes = request.outputLimitBytes || 65536;

    const dockerArgs = [
      'run',
      '--rm',
      '-i',
      '--network', 'none',
      '--memory', `${memoryLimitMb}m`,
      '--cpus', '1.0',
      '--pids-limit', '64',
      '--user', '1000:1000',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      this.dockerImage,
    ];

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
      const child = spawn('docker', dockerArgs);

      let stdoutData = '';
      let stderrData = '';
      let isSettled = false;

      // Hard timeout for container spawn (time limit + 3s margin for container lifecycle)
      const timeoutTimer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          try {
            child.kill('SIGKILL');
          } catch (e) {
            // ignore
          }
          resolve({
            exitCode: -1,
            timedOut: true,
            stdout: '',
            stderr: 'Docker runner execution timed out',
            executionTimeMs: Date.now() - startTime,
            memoryUsageMb: memoryLimitMb,
            outputTruncated: false,
            executionMode: 'docker',
          });
        }
      }, timeLimitMs + 3000);

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
          this.logger.error(`Docker runner spawn failure: ${err.message}`, err.stack, 'DockerRunner');
          resolve({
            exitCode: -1,
            timedOut: false,
            stdout: '',
            stderr: `Docker spawn error: ${err.message}`,
            executionTimeMs: Date.now() - startTime,
            memoryUsageMb: 0,
            outputTruncated: false,
            executionMode: 'docker',
            isInfrastructureError: true,
          });
        }
      });

      child.on('close', (code) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutTimer);

          if (code === 71 || (code !== 0 && !stdoutData.trim())) {
            // Controllable runner crash or docker daemon failure
            resolve({
              exitCode: code ?? -1,
              timedOut: false,
              stdout: '',
              stderr: stderrData || 'Controllable runner infrastructure failure',
              executionTimeMs: Date.now() - startTime,
              memoryUsageMb: 0,
              outputTruncated: false,
              executionMode: 'docker',
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
              executionMode: 'docker',
            });
          } catch (e) {
            resolve({
              exitCode: code ?? -1,
              timedOut: false,
              stdout: stdoutData,
              stderr: stderrData || 'Failed to parse runner output',
              executionTimeMs: Date.now() - startTime,
              memoryUsageMb: 0,
              outputTruncated: false,
              executionMode: 'docker',
              isInfrastructureError: true,
            });
          }
        }
      });

      try {
        child.stdin.write(payload);
        child.stdin.end();
      } catch (err) {
        // Child closed stdin early
      }
    });
  }
}
