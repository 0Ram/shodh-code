import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { LeaderboardService } from './leaderboard.service';
import { LeaderboardQueryDto } from './dto/leaderboard-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgRolesGuard } from '../common/guards/org-roles.guard';
import { OrgRoles } from '../common/decorators/roles.decorator';
import { OrgRole } from '@prisma/client';

@ApiTags('Leaderboard')
@Controller('api/v1/contests/:contestId/leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  @Get()
  @ApiOperation({ summary: 'Get contest leaderboard with pagination and stable deterministic ranking' })
  async getLeaderboard(
    @Param('contestId') contestId: string,
    @Query() query: LeaderboardQueryDto,
  ) {
    return this.leaderboardService.getLeaderboard(contestId, query);
  }

  @Post('rebuild')
  @UseGuards(JwtAuthGuard, OrgRolesGuard)
  @OrgRoles(OrgRole.ORGANIZER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Rebuild standings from authoritative submissions and verify consistency (ORGANIZER only)' })
  async rebuildStandings(@Param('contestId') contestId: string) {
    return this.leaderboardService.rebuildStandings(contestId);
  }
}
