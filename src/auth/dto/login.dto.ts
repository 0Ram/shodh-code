import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'organizer.alpha@shodh.test' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  password: string;
}

export class DevTokenDto {
  @ApiProperty({ example: 'student1@shodh.test', description: 'Development fixture email to impersonate' })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}
