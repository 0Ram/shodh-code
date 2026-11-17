import { Module } from '@nestjs/common';
import { JudgeService } from './judge.service';
import { JudgeWorkerService } from './worker/judge-worker.service';
import { OutboxDispatcherService } from './outbox/outbox-dispatcher.service';
import { DockerRunnerService } from './runner/docker-runner.service';
import { SubprocessRunnerService } from './runner/subprocess-runner.service';
import { RunnerFactory } from './runner/runner.factory';
import { AppLoggerService } from '../common/logger/app-logger.service';

@Module({
  providers: [
    JudgeService,
    JudgeWorkerService,
    OutboxDispatcherService,
    DockerRunnerService,
    SubprocessRunnerService,
    RunnerFactory,
    AppLoggerService,
  ],
  exports: [
    JudgeService,
    JudgeWorkerService,
    OutboxDispatcherService,
    RunnerFactory,
  ],
})
export class JudgeModule {}
