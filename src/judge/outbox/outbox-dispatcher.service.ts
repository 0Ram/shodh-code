import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AppLoggerService } from '../../common/logger/app-logger.service';
import { OutboxStatus } from '@prisma/client';

@Injectable()
export class OutboxDispatcherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLoggerService,
  ) {}

  async dispatchPendingEvents(batchSize = 10): Promise<number> {
    const events = await this.prisma.outboxEvent.findMany({
      where: { status: OutboxStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });

    if (events.length === 0) return 0;

    for (const event of events) {
      try {
        this.logger.log(
          `Dispatched outbox event ${event.id} [${event.aggregateType}:${event.eventType}]`,
          'OutboxDispatcher',
          { eventId: event.id, aggregateId: event.aggregateId },
        );

        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: OutboxStatus.PROCESSED,
            processedAt: new Date(),
          },
        });
      } catch (err: any) {
        this.logger.error(`Failed to dispatch outbox event ${event.id}: ${err.message}`, err.stack, 'OutboxDispatcher');
      }
    }

    return events.length;
  }
}
