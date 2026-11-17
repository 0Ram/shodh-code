import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { SubmissionsService } from './submissions.service';
import { CreateSubmissionDto, RejudgeSubmissionDto } from './dto/create-submission.dto';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';

@ApiTags('Submissions')
@Controller('api/v1')
export class SubmissionsController {
  constructor(private submissionsService: SubmissionsService) {}

  @Post('contests/:contestId/submissions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiHeader({ name: 'x-idempotency-key', required: false, description: 'Optional header for idempotent retries' })
  @ApiOperation({ summary: 'Submit solution to a contest problem (returns submission ID immediately)' })
  async createSubmission(
    @Param('contestId') contestId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSubmissionDto,
    @Headers('x-idempotency-key') idempotencyHeader?: string,
  ) {
    return this.submissionsService.createSubmission(contestId, user, dto, idempotencyHeader);
  }

  @Get('submissions/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get submission status, verdict and attempt history' })
  async getSubmission(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.submissionsService.getSubmission(id, user);
  }

  @Get('contests/:contestId/submissions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List submissions for a contest (participants see own; organizers see all)' })
  async listSubmissions(
    @Param('contestId') contestId: string,
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.submissionsService.listSubmissions(contestId, query, user);
  }

  @Post('submissions/:id/rejudge')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Trigger rejudging of submission against problem/test-suite version (ORGANIZER only)' })
  async rejudgeSubmission(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RejudgeSubmissionDto,
  ) {
    return this.submissionsService.rejudgeSubmission(id, user, dto);
  }
}
