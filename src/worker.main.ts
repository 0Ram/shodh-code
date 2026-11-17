import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JudgeWorkerService } from './judge/worker/judge-worker.service';
import { AppLoggerService } from './common/logger/app-logger.service';

async function bootstrapWorker() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(AppLoggerService);
  app.useLogger(logger);

  const worker = app.get(JudgeWorkerService);
  logger.log(`Starting independent Judge Worker process: ${worker.workerId}`, 'WorkerBootstrap');

  worker.start();

  const handleShutdown = async (signal: string) => {
    logger.log(`Received ${signal}, shutting down worker gracefully...`, 'WorkerBootstrap');
    await worker.stop();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

bootstrapWorker();
