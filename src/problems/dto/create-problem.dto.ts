import {
  IsNotEmpty,
  IsString,
  IsInt,
  Min,
  Max,
  IsArray,
  ValidateNested,
  IsBoolean,
  IsOptional,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TestCaseDto {
  @ApiProperty({ example: '3 5\n' })
  @IsString()
  input: string;

  @ApiProperty({ example: '8\n' })
  @IsString()
  expectedOutput: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isSample?: boolean = false;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  weight?: number = 10;
}

export class CreateProblemDto {
  @ApiProperty({ example: 'PROB-A' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z0-9_-]+$/, {
    message: 'Code must contain uppercase letters, numbers, hyphens or underscores',
  })
  code: string;

  @ApiProperty({ example: 'Sum of Two Numbers' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: 'Given two integers a and b, output their sum.' })
  @IsString()
  @IsNotEmpty()
  statement: string;

  @ApiPropertyOptional({ default: 2000, description: 'Time limit in milliseconds' })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(10000)
  timeLimitMs?: number = 2000;

  @ApiPropertyOptional({ default: 128, description: 'Memory limit in Megabytes' })
  @IsOptional()
  @IsInt()
  @Min(16)
  @Max(1024)
  memoryLimitMb?: number = 128;

  @ApiProperty({ type: [TestCaseDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TestCaseDto)
  testCases: TestCaseDto[];
}

export class CreateProblemVersionDto {
  @ApiProperty({ example: 'Updated problem statement with clarified constraints' })
  @IsString()
  @IsNotEmpty()
  statement: string;

  @ApiPropertyOptional({ default: 2000 })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(10000)
  timeLimitMs?: number = 2000;

  @ApiPropertyOptional({ default: 128 })
  @IsOptional()
  @IsInt()
  @Min(16)
  @Max(1024)
  memoryLimitMb?: number = 128;

  @ApiProperty({ type: [TestCaseDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TestCaseDto)
  testCases: TestCaseDto[];
}
