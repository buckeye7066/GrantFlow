export const ROLES = [
  'owner', 'admin', 'grant_manager', 'contributor', 'reviewer',
  'finance', 'viewer', 'connector_admin', 'security_admin', 'auditor',
];

export const ROLE_LABELS = {
  owner: 'Owner',
  admin: 'Administrator',
  grant_manager: 'Grant Manager',
  contributor: 'Contributor',
  reviewer: 'Reviewer',
  finance: 'Finance',
  viewer: 'Viewer',
  connector_admin: 'Connector Administrator',
  security_admin: 'Security Administrator',
  auditor: 'Auditor',
};

const MATRIX = {
  'opportunities:view': ['owner','admin','grant_manager','contributor','reviewer','finance','viewer','auditor'],
  'opportunities:search': ['owner','admin','grant_manager','contributor','reviewer','viewer'],
  'recommendations:view': ['owner','admin','grant_manager','contributor','reviewer','viewer'],
  'funders:view': ['owner','admin','grant_manager','contributor','reviewer','finance','viewer','auditor'],
  'knowledge:view': ['owner','admin','grant_manager','contributor','reviewer','finance','viewer'],
  'knowledge:edit': ['owner','admin','grant_manager','contributor'],
  'proposals:view': ['owner','admin','grant_manager','contributor','reviewer','viewer'],
  'proposals:edit': ['owner','admin','grant_manager','contributor'],
  'proposals:approve': ['owner','admin','grant_manager','reviewer'],
  'pipeline:view': ['owner','admin','grant_manager','contributor','reviewer','finance','viewer'],
  'pipeline:edit': ['owner','admin','grant_manager','contributor'],
  'pipeline:submit': ['owner','admin','grant_manager','contributor'],
  'awards:view': ['owner','admin','grant_manager','contributor','reviewer','finance','viewer'],
  'awards:edit': ['owner','admin','finance','grant_manager'],
  'calendar:view': ['owner','admin','grant_manager','contributor','reviewer','finance','viewer'],
  'profiles:view': ['owner','admin','grant_manager','contributor','reviewer','viewer'],
  'profiles:edit': ['owner','admin','grant_manager','contributor'],
  'onboarding:manage': ['owner','admin','grant_manager','contributor'],
  'connectors:admin': ['owner','admin','connector_admin'],
  'security:admin': ['owner','admin','security_admin'],
  'audit:view': ['owner','admin','security_admin','auditor'],
  'exports:run': ['owner','admin','security_admin','auditor'],
  'data:delete': ['owner','admin','security_admin'],
  'documents:download': ['owner','admin','grant_manager','contributor','reviewer','finance'],
};

export function can(role, permission) {
  if (!role) return false;
  const allowed = MATRIX[permission];
  if (!allowed) return false;
  return allowed.indexOf(role) !== -1;
}

export function explainDenied(role, permission) {
  if (can(role, permission)) return null;
  const map = {
    'connectors:admin': 'Only connector administrators can manage authorized source connectors.',
    'security:admin': 'Only security administrators can manage users, roles, exports, and audit logs.',
    'audit:view': 'Only auditors and security administrators can view audit events.',
    'data:delete': 'Account deletion requires a security administrator or owner.',
    'exports:run': 'Running data exports requires a role permitted to export tenant data.',
    'pipeline:submit': 'Recording a submission requires permission to advance the pipeline.',
    'proposals:approve': 'Approving proposal sections is restricted to managers and reviewers.',
  };
  return map[permission] || 'Your role does not permit this action. Ask an administrator if you need access.';
}
