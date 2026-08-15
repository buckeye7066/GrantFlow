import { describe, expect, test } from 'vitest';
import * as rbac from '../src/lib/rbac.js';

const permissionFunctionNames = [
  'can',
  'canAccess',
  'hasPermission',
  'isAllowed',
  'authorize',
  'isAuthorized',
  'may'
];

function getPermissionFunction() {
  for (const name of permissionFunctionNames) {
    if (typeof rbac[name] === 'function') return rbac[name];
  }

  const functionEntry = Object.entries(rbac).find(([, value]) => typeof value === 'function');
  return functionEntry?.[1];
}

function unwrapPermissionResult(result) {
  if (typeof result === 'boolean') return result;
  if (result && typeof result.allowed === 'boolean') return result.allowed;
  if (result && typeof result.ok === 'boolean') return result.ok;
  if (result && typeof result.authorized === 'boolean') return result.authorized;
  return undefined;
}

function evaluatePermission(fn, { role, action, resource, tenantId = 'tenant-a', resourceTenantId = 'tenant-a' }) {
  const user = { id: `${role}-user`, role, tenantId };
  const resourceObject = { id: `${resource}-1`, type: resource, tenantId: resourceTenantId };

  const attempts = [
    () => fn(user, action, resource),
    () => fn(user, action, resourceObject),
    () => fn(role, action, resource),
    () => fn(action, resource, user),
    () => fn({ user, action, resource }),
    () => fn({ role, action, resource, tenantId, resourceTenantId }),
    () => fn({ actor: user, action, subject: resourceObject }),
    () => fn({ actor: user, permission: action, resource: resourceObject })
  ];

  for (const attempt of attempts) {
    try {
      const normalized = unwrapPermissionResult(attempt());
      if (typeof normalized === 'boolean') return normalized;
    } catch {
      // Try the next common RBAC call signature.
    }
  }

  return undefined;
}

describe('RBAC security invariants', () => {
  test('exports a permission evaluation function', () => {
    expect(getPermissionFunction(), 'src/lib/rbac.js should export a permission evaluator').toBeTypeOf('function');
  });

  test('non-admin roles cannot administer connectors, view audit logs, export tenant data, or delete accounts', () => {
    const can = getPermissionFunction();
    const deniedRoles = ['viewer', 'member', 'writer', 'analyst', 'collaborator'];
    const sensitiveActions = [
      ['manage', 'connector'],
      ['admin', 'connector'],
      ['read', 'auditLog'],
      ['export', 'tenantData'],
      ['delete', 'account'],
      ['changeRole', 'user']
    ];

    for (const role of deniedRoles) {
      for (const [action, resource] of sensitiveActions) {
        const result = evaluatePermission(can, { role, action, resource });
        expect(result, `${role} should be denied ${action}:${resource}`).toBe(false);
      }
    }
  });

  test('admin or owner role can perform connector administration and audit review', () => {
    const can = getPermissionFunction();
    const privilegedRoles = ['admin', 'owner'];

    for (const role of privilegedRoles) {
      const connectorResult = evaluatePermission(can, { role, action: 'manage', resource: 'connector' });
      const auditResult = evaluatePermission(can, { role, action: 'read', resource: 'auditLog' });

      expect(connectorResult, `${role} should be allowed to manage connectors`).toBe(true);
      expect(auditResult, `${role} should be allowed to read audit logs`).toBe(true);
    }
  });

  test('cross-tenant resource access is denied even for normal read operations', () => {
    const can = getPermissionFunction();
    const roles = ['viewer', 'member', 'writer', 'analyst', 'admin'];

    for (const role of roles) {
      const result = evaluatePermission(can, {
        role,
        action: 'read',
        resource: 'opportunityMatch',
        tenantId: 'tenant-a',
        resourceTenantId: 'tenant-b'
      });

      expect(result, `${role} should not read another tenant's opportunity matches`).toBe(false);
    }
  });
});
