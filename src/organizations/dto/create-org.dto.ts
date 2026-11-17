import { IsNotEmpty, IsString, Matches, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Delta Coding Club' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'delta-club' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug must contain only lowercase alphanumeric characters and hyphens',
  })
  slug: string;
}

export class AddMemberDto {
  @ApiProperty({ example: 'student4@shodh.test' })
  @IsNotEmpty()
  userEmail: string;

  @ApiProperty({ enum: OrgRole, default: OrgRole.PARTICIPANT })
  @IsEnum(OrgRole)
  role: OrgRole;
}
