import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrganizationDto, AddMemberDto } from './dto/create-org.dto';
import { OrgRole } from '@prisma/client';

@Injectable()
export class OrganizationsService {
  constructor(private prisma: PrismaService) {}

  async createOrganization(creatorId: string, dto: CreateOrganizationDto) {
    const existing = await this.prisma.organization.findUnique({
      where: { slug: dto.slug },
    });
    if (existing) {
      throw new ConflictException(`Organization with slug '${dto.slug}' already exists`);
    }

    return this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: dto.name,
          slug: dto.slug,
        },
      });

      await tx.organizationMember.create({
        data: {
          organizationId: org.id,
          userId: creatorId,
          role: OrgRole.ORGANIZER,
        },
      });

      return org;
    });
  }

  async getOrganization(idOrSlug: string) {
    const org = await this.prisma.organization.findFirst({
      where: {
        OR: [{ id: idOrSlug }, { slug: idOrSlug }],
      },
      include: {
        members: {
          include: {
            user: { select: { id: true, email: true, name: true } },
          },
        },
      },
    });

    if (!org) {
      throw new NotFoundException(`Organization '${idOrSlug}' not found`);
    }
    return org;
  }

  async listOrganizations() {
    return this.prisma.organization.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { members: true, contests: true, problems: true } },
      },
    });
  }

  async addMember(organizationId: string, dto: AddMemberDto) {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`);
    }

    const user = await this.prisma.user.findUnique({ where: { email: dto.userEmail } });
    if (!user) {
      throw new NotFoundException(`User with email ${dto.userEmail} not found`);
    }

    const existingMember = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId: user.id,
        },
      },
    });

    if (existingMember) {
      return this.prisma.organizationMember.update({
        where: { id: existingMember.id },
        data: { role: dto.role },
      });
    }

    return this.prisma.organizationMember.create({
      data: {
        organizationId,
        userId: user.id,
        role: dto.role,
      },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    });
  }
}
