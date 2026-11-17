import { Injectable } from '@nestjs/common';
import { ICodeRunner } from './runner.interface';
import { DockerRunnerService } from './docker-runner.service';
import { SubprocessRunnerService } from './subprocess-runner.service';

@Injectable()
export class RunnerFactory {
  constructor(
    private readonly dockerRunner: DockerRunnerService,
    private readonly subprocessRunner: SubprocessRunnerService,
  ) {}

  getRunner(overrideMode?: 'docker' | 'subprocess'): ICodeRunner {
    const mode = overrideMode || process.env.RUNNER_MODE || 'docker';
    if (mode === 'subprocess') {
      return this.subprocessRunner;
    }
    return this.dockerRunner;
  }
}
