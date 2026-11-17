import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { AppLoggerService } from './common/logger/app-logger.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(AppLoggerService);
  app.useLogger(logger);

  // Global exception filter for clear error distinction
  app.useGlobalFilters(new AllExceptionsFilter());

  // Strict request validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.enableCors();

  // Swagger OpenAPI documentation
  const config = new DocumentBuilder()
    .setTitle('Shodh a Code - Contest Platform API')
    .setDescription(
      'Deterministic coding contest platform backend featuring transactional outbox, asynchronous Docker judging, attempt fencing, and immutable problem versions.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`API Server successfully started on port ${port}`, 'Bootstrap');
  logger.log(`OpenAPI documentation available at http://localhost:${port}/api/docs`, 'Bootstrap');
}

bootstrap();
