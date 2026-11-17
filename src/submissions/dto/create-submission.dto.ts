import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsIn,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSubmissionDto {
  @ApiProperty({ example: 'uuid-of-problem' })
  @IsString()
  @IsNotEmpty()
  problemId: string;

  @ApiPropertyOptional({ default: 'python3', enum: ['python3'] })
  @IsOptional()
  @IsString()
  @IsIn(['python3'])
  language: string = 'python3';

  @ApiProperty({ example: 'print("Hello World")' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(65536)
  sourceCode: string;

  @ApiPropertyOptional({ example: 'req-idem-12345', description: 'Idempotency key per actor + contest' })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class RejudgeSubmissionDto {
  @ApiPropertyOptional({ description: 'Optional specific problem version ID to judge against' })
  @IsOptional()
  @IsString()
  problemVersionId?: string;

  @ApiPropertyOptional({ description: 'Optional specific test suite version ID to judge against' })
  @IsOptional()
  @IsString()
  testSuiteVersionId?: string;
}
