import { IsNotEmpty, IsString, Matches, IsDateString, IsOptional, IsInt, Min, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateContestDto {
  @ApiProperty({ example: 'Code Sprint 2026' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: 'code-sprint-2026' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug must contain only lowercase alphanumeric characters and hyphens',
  })
  slug: string;

  @ApiPropertyOptional({ example: 'Spring annual coding contest' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: '2026-11-17T10:00:00Z' })
  @IsDateString()
  startTime: string;

  @ApiProperty({ example: '2026-11-17T18:00:00Z' })
  @IsDateString()
  endTime: string;

  @ApiPropertyOptional({ default: 'ICPC', enum: ['ICPC', 'PARTIAL'] })
  @IsOptional()
  @IsIn(['ICPC', 'PARTIAL'])
  scoringRule?: string;

  @ApiPropertyOptional({ default: 1200, description: 'Penalty in seconds per failed attempt (default 20 mins)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  penaltyPerFailedAttemptSec?: number;
}

export class AttachProblemDto {
  @ApiProperty({ example: 'uuid-of-problem' })
  @IsString()
  @IsNotEmpty()
  problemId: string;

  @ApiProperty({ example: 'A', description: 'Problem alias letter in contest' })
  @IsString()
  @IsNotEmpty()
  alias: string;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  points?: number;
}
