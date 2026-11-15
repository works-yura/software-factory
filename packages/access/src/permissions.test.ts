import { describe, expect, it } from 'vitest';

import { ASSIGNABLE_ROLES, can, isAssignableRole, PERMISSIONS, permissionsFor, ROLES } from './permissions.ts';
import type { Permission, Role } from './permissions.ts';

/** The matrix as people read it (ADR-0045): one row per permission, which roles hold it. */
const EXPECTED: Record<Permission, Role[]> = {
  'board.read': ['viewer', 'member', 'admin', 'owner'],
  'self.write': ['viewer', 'member', 'admin', 'owner'],
  'card.write': ['member', 'admin', 'owner'],
  'comment.write': ['member', 'admin', 'owner'],
  'run.start': ['member', 'admin', 'owner'],
  'session.write': ['member', 'admin', 'owner'],
  'factory.configure': ['member', 'admin', 'owner'],
  'factory.manage': ['admin', 'owner'],
  'connections.manage': ['admin', 'owner'],
  'org.manage': ['admin', 'owner'],
  'members.manage': ['admin', 'owner'],
  'join-links.manage': ['admin', 'owner'],
  'content.moderate': ['admin', 'owner'],
};

describe('the role matrix', () => {
  it.each(PERMISSIONS)('%s is held by exactly the expected roles', permission => {
    expect(ROLES.filter(role => can(role, permission)).sort()).toEqual([...EXPECTED[permission]].sort());
  });

  it('covers every permission in the catalog', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...PERMISSIONS].sort());
  });

  it('gives a viewer reads and their own state only', () => {
    expect(permissionsFor('viewer')).toEqual(['board.read', 'self.write']);
  });

  it('gives the owner exactly an admin’s permissions', () => {
    expect(permissionsFor('owner')).toEqual(permissionsFor('admin'));
  });

  it('gives an unknown or missing role nothing', () => {
    for (const role of ['superuser', '', null, undefined]) {
      expect(PERMISSIONS.some(permission => can(role, permission))).toBe(false);
      expect(permissionsFor(role)).toEqual([]);
    }
  });

  it('never lets anyone be given owner', () => {
    expect(ASSIGNABLE_ROLES).toEqual(['viewer', 'member', 'admin']);
    expect(isAssignableRole('owner')).toBe(false);
  });
});
