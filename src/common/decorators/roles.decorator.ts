import { SetMetadata } from '@nestjs/common';
import { GlobalRole, OrgRole } from '@prisma/client';

export const GLOBAL_ROLES_KEY = 'global_roles';
export const GlobalRoles = (...roles: GlobalRole[]) => SetMetadata(GLOBAL_ROLES_KEY, roles);

export const ORG_ROLES_KEY = 'org_roles';
export const OrgRoles = (...roles: OrgRole[]) => SetMetadata(ORG_ROLES_KEY, roles);
