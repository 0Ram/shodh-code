import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GlobalRole } from '@prisma/client';
import { GLOBAL_ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedUser } from '../decorators/current-user.decorator';

@Injectable()
export class GlobalRolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<GlobalRole[]>(GLOBAL_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
    if (!user) {
      throw new ForbiddenException('Unauthenticated actor');
    }

    if (user.globalRole === GlobalRole.SUPERADMIN) {
      return true;
    }

    const hasRole = requiredRoles.includes(user.globalRole);
    if (!hasRole) {
      throw new ForbiddenException(`Insufficient global privileges. Required: ${requiredRoles.join(', ')}`);
    }

    return true;
  }
}
