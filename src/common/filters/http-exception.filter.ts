import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppLoggerService } from '../logger/app-logger.service';

export class BusinessRuleException extends HttpException {
  constructor(message: string, statusCode = HttpStatus.UNPROCESSABLE_ENTITY) {
    super(
      {
        statusCode,
        error: 'BusinessRuleViolation',
        message,
      },
      statusCode,
    );
  }
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new AppLoggerService();

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId = (request.headers['x-request-id'] as string) || (request as any).id || 'req-untracked';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorResponse: any = {
      statusCode: status,
      error: 'InternalServerError',
      message: 'An unexpected internal error occurred.',
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'object' && res !== null) {
        errorResponse = {
          ...res,
          statusCode: status,
        };
      } else {
        errorResponse = {
          statusCode: status,
          message: res,
        };
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled error processing request: ${exception.message}`,
        exception.stack,
        'AllExceptionsFilter',
        { requestId, path: request.url, method: request.method },
      );
      errorResponse = {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'InternalServerError',
        message: 'Internal infrastructure or system error.',
      };
    }

    errorResponse.timestamp = new Date().toISOString();
    errorResponse.path = request.url;
    errorResponse.requestId = requestId;

    response.status(status).json(errorResponse);
  }
}
