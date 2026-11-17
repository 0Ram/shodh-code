import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProblemsService } from './problems.service';
import { CreateProblemDto, CreateProblemVersionDto } from './dto/create-problem.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgRolesGuard } from '../common/guards/org-roles.guard';
import { OrgRoles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { OrgRole } from '@prisma/client';

@ApiTags('Problems')
@Controller('api/v1')
export class ProblemsController {
  constructor(private problemsService: ProblemsService) {}

  @Post('organizations/:orgId/problems')
  @UseGuards(JwtAuthGuard, OrgRolesGuard)
  @OrgRoles(OrgRole.ORGANIZER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create problem with initial version and test cases (ORGANIZER only)' })
  async createProblem(
    @Param('orgId') orgId: string,
    @Body() dto: CreateProblemDto,
  ) {
    return this.problemsService.createProblem(orgId, dto);
  }

  @Post('problems/:id/versions')
  @UseGuards(JwtAuthGuard, OrgRolesGuard)
  @OrgRoles(OrgRole.ORGANIZER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create new immutable problem version (ORGANIZER only)' })
  async createNewVersion(
    @Param('id') id: string,
    @Body() dto: CreateProblemVersionDto,
  ) {
    return this.problemsService.createNewVersion(id, dto);
  }

  @Get('problems/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get problem details (hidden test cases protected from participants)' })
  async getProblem(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.problemsService.getProblem(id, user);
  }

  @Get('contests/:contestId/problems')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List problems for a contest' })
  async listContestProblems(
    @Param('contestId') contestId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.problemsService.listContestProblems(contestId, user);
  }
}
