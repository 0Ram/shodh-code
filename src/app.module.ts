import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { ContestsModule } from './contests/contests.module';
import { ProblemsModule } from './problems/problems.module';
import { SubmissionsModule } from './submissions/submissions.module';
import { JudgeModule } from './judge/judge.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { AppLoggerService } from './common/logger/app-logger.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    OrganizationsModule,
    ContestsModule,
    ProblemsModule,
    SubmissionsModule,
    JudgeModule,
    LeaderboardModule,
  ],
  providers: [AppLoggerService],
})
export class AppModule {}
