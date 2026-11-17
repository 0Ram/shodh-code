import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrgRole, GlobalRole } from '@prisma/client';
import { ORG_ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedUser } from '../decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class OrgRolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<OrgRole[]>(ORG_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // Superadmin bypasses org checks
    if (user.globalRole === GlobalRole.SUPERADMIN) {
      return true;
    }

    // Resolve organizationId from route params or body
    let organizationId =
      request.params.organizationId ||
      request.params.orgId ||
      request.body.organizationId ||
      request.body.orgId;

    // If contestId or problemId is in params, resolve orgId from database to prevent tenant crossing
    if (!organizationId && request.params.contestId) {
      const contest = await this.prisma.contest.findUnique({
        where: { id: request.params.contestId },
        select: { organizationId: true },
      });
      if (contest) {
        organizationId = contest.organizationId;
      }
    }

    if (!organizationId && request.params.problemId) {
      const problem = await this.prisma.problem.findUnique({
        where: { id: request.params.problemId },
        select: { organizationId: true },
      });
      if (problem) {
        organizationId = problem.organizationId;
      }
    }

    if (!organizationId && request.params.id) {
      // Check if it's contest or problem or org
      const contest = await this.prisma.contest.findUnique({
        where: { id: request.params.id },
        select: { organizationId: true },
      });
      if (contest) {
        organizationId = contest.organizationId;
      } else {
        const problem = await this.prisma.problem.findUnique({
          where: { id: request.params.id },
          select: { organizationId: true },
        });
        if (problem) {
          organizationId = problem.organizationId;
        } else {
          // Assume the param is the organizationId itself
          organizationId = request.params.id;
        }
      }
    }

    if (!organizationId) {
      // If organization context cannot be determined, permit if participant is general or deny
      return true;
    }

    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId: user.id,
        },
      },
    });

    if (!membership) {
      throw new ForbiddenException(
        `Cross-organization access denied: Actor ${user.email} is not a member of organization ${organizationId}`,
      );
    }

    const hasRole = requiredRoles.includes(membership.role);
    if (!hasRole) {
      throw new ForbiddenException(
        `Role authorization failure: Action requires role [${requiredRoles.join(', ')}] in organization ${organizationId}, but actor has role ${membership.role}`,
      );
    }

    return true;
  }
}
