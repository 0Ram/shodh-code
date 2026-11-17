import { Injectable, LoggerService } from '@nestjs/common';
import pino from 'pino';

@Injectable()
export class AppLoggerService implements LoggerService {
  private readonly logger: pino.Logger;

  constructor() {
    this.logger = pino({
      level: process.env.LOG_LEVEL || 'info',
      transport:
        process.env.NODE_ENV !== 'production'
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
              },
            }
          : undefined,
      redact: {
        paths: [
          'password',
          'passwordHash',
          'token',
          'authorization',
          'req.headers.authorization',
          '*.expectedOutput',
          'expectedOutput',
          '*.testCases',
          'testCases',
        ],
        censor: '[REDACTED]',
      },
    });
  }

  log(message: any, context?: string, metadata?: Record<string, any>) {
    this.logger.info({ context, ...metadata }, typeof message === 'object' ? JSON.stringify(message) : message);
  }

  error(message: any, trace?: string, context?: string, metadata?: Record<string, any>) {
    this.logger.error({ context, trace, ...metadata }, typeof message === 'object' ? JSON.stringify(message) : message);
  }

  warn(message: any, context?: string, metadata?: Record<string, any>) {
    this.logger.warn({ context, ...metadata }, typeof message === 'object' ? JSON.stringify(message) : message);
  }

  debug(message: any, context?: string, metadata?: Record<string, any>) {
    this.logger.debug({ context, ...metadata }, typeof message === 'object' ? JSON.stringify(message) : message);
  }

  verbose(message: any, context?: string, metadata?: Record<string, any>) {
    this.logger.trace({ context, ...metadata }, typeof message === 'object' ? JSON.stringify(message) : message);
  }
}
