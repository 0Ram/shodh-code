import { Controller, Post, Get, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OrganizationsService } from './organizations.service';
import { CreateOrganizationDto, AddMemberDto } from './dto/create-org.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgRolesGuard } from '../common/guards/org-roles.guard';
import { OrgRoles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { OrgRole } from '@prisma/client';

@ApiTags('Organizations')
@Controller('api/v1/organizations')
export class OrganizationsController {
  constructor(private orgsService: OrganizationsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new organization (caller becomes ORGANIZER)' })
  async createOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOrganizationDto,
  ) {
    return this.orgsService.createOrganization(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all organizations' })
  async listOrganizations() {
    return this.orgsService.listOrganizations();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get organization details and members' })
  async getOrganization(@Param('id') id: string) {
    return this.orgsService.getOrganization(id);
  }

  @Post(':id/members')
  @UseGuards(JwtAuthGuard, OrgRolesGuard)
  @OrgRoles(OrgRole.ORGANIZER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Add or update organization member (ORGANIZER only)' })
  async addMember(@Param('id') id: string, @Body() dto: AddMemberDto) {
    return this.orgsService.addMember(id, dto);
  }
}
