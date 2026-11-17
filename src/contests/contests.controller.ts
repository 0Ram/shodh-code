import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ContestsService } from './contests.service';
import { CreateContestDto, AttachProblemDto } from './dto/create-contest.dto';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgRolesGuard } from '../common/guards/org-roles.guard';
import { OrgRoles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { OrgRole } from '@prisma/client';

@ApiTags('Contests')
@Controller('api/v1')
export class ContestsController {
  constructor(private contestsService: ContestsService) {}

  @Post('organizations/:orgId/contests')
  @UseGuards(JwtAuthGuard, OrgRolesGuard)
  @OrgRoles(OrgRole.ORGANIZER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create contest for organization (ORGANIZER only)' })
  async createContest(
    @Param('orgId') orgId: string,
    @Body() dto: CreateContestDto,
  ) {
    return this.contestsService.createContest(orgId, dto);
  }

  @Get('contests')
  @ApiOperation({ summary: 'List contests with pagination and stable ordering' })
  async listContests(@Query() query: PaginationQueryDto) {
    return this.contestsService.listContests(query);
  }

  @Get('contests/:id')
  @ApiOperation({ summary: 'Get contest details and problems' })
  async getContest(@Param('id') id: string) {
    return this.contestsService.getContest(id);
  }

  @Post('contests/:id/register')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Register authenticated user as participant in contest' })
  async register(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.contestsService.registerParticipant(id, user.id);
  }

  @Post('contests/:id/problems')
  @UseGuards(JwtAuthGuard, OrgRolesGuard)
  @OrgRoles(OrgRole.ORGANIZER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Attach problem to contest (ORGANIZER only)' })
  async attachProblem(
    @Param('id') id: string,
    @Body() dto: AttachProblemDto,
  ) {
    return this.contestsService.attachProblem(id, dto);
  }
}
