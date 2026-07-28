/**
 * Prove the mutation policy blocks what it claims to block.
 *
 * The application lane's entire safety story rests on classify(). If it
 * silently allowed everything, a live run would look IDENTICAL — no errors, no
 * blocked requests, a clean report — right up until something submitted a real
 * application on a real person's behalf. So the policy is tested directly,
 * offline, before any browser exists.
 *
 * Both directions are asserted. A test that only checks "dangerous things are
 * blocked" would pass a broken deny-everything policy, which fails closed but
 * also produces an empty audit while looking healthy — so the cases that MUST
 * be allowed are asserted just as hard.
 *
 * Run: node scripts/production-audit/policy.test.mjs
 */

import { classify } from './app-audit.mjs';

const B = 'https://app.axiombiolabs.org';

/** [method, url, expectAllow, options, why] */
const CASES = [
  // ---- must be ALLOWED ---------------------------------------------------
  ['GET', `${B}/api/profiles`, true, {}, 'reads are the entire point'],
  ['GET', `${B}/api/hamilton/automation/tasks?profileId=x`, true, {}, 'task read'],
  ['HEAD', `${B}/`, true, {}, 'harmless'],
  ['OPTIONS', `${B}/api/anything`, true, {}, 'preflight'],
  ['POST', `${B}/api/auth/access/check`, true, {}, 'read-only auth-method lookup; login cannot advance without it'],
  ['POST', `${B}/api/auth/password/login`, true, {}, 'nothing is visible without a session'],
  ['POST', `${B}/api/auth/refresh`, true, {}, 'session refresh'],
  ['POST', `${B}/api/auth/logout`, true, {}, 'clean logout'],

  // ---- the conditional route --------------------------------------------
  [
    'POST',
    `${B}/api/hamilton/portal-sync/read`,
    true,
    { allowPortalRead: true, allowedPortalHosts: ['studentaid.gov'] },
    'read-only sync, explicitly requested with a named host',
  ],
  [
    'POST',
    `${B}/api/hamilton/portal-sync/read`,
    false,
    {},
    'the SAME route is blocked when portal reads were not requested',
  ],
  [
    'POST',
    `${B}/api/hamilton/portal-sync/read`,
    false,
    { allowPortalRead: true, allowedPortalHosts: [] },
    'requested but no host named — still blocked',
  ],

  // ---- must be BLOCKED ---------------------------------------------------
  ['POST', `${B}/api/hamilton/portal-sync/write`, false, { allowPortalRead: true, allowedPortalHosts: ['x'] }, 'writes to the portal'],
  ['POST', `${B}/api/hamilton/portal-sync/sync`, false, { allowPortalRead: true, allowedPortalHosts: ['x'] }, 'direction "both" — writes'],
  ['POST', `${B}/api/hamilton/tailored/submit`, false, {}, 'submits an application'],
  ['POST', `${B}/api/hamilton/automation/tasks/1/approve`, false, {}, 'approval'],
  ['POST', `${B}/api/hamilton/automation/authorize`, false, {}, 'authorization'],
  ['POST', `${B}/api/hamilton/automation/payment-authorizations`, false, {}, 'money'],
  ['POST', `${B}/api/application-tasks/1/auto-submit`, false, {}, 'arms auto-submit'],
  ['POST', `${B}/api/hamilton/automation/sessions/import`, false, {}, 'imports session material'],
  ['POST', `${B}/api/billing/subscribe`, false, {}, 'billing'],
  ['PATCH', `${B}/api/profiles/abc`, false, {}, 'mutates a real profile'],
  ['PUT', `${B}/api/profiles/abc/sections/financial`, false, {}, 'mutates financial-aid data'],
  ['DELETE', `${B}/api/grants/xyz`, false, {}, 'destructive'],
  ['POST', `${B}/api/admin/users`, false, {}, 'account management'],
  ['POST', `https://evil.example.com/anything`, false, {}, 'default-deny applies off-origin too'],
  ['POST', `${B}/api/auth/password/setup/complete`, false, {}, 'changes a credential — not an audit action'],
];

let pass = 0;
const failures = [];

for (const [method, url, expectAllow, opts, why] of CASES) {
  const got = classify(method, url, opts).allow === true;
  if (got === expectAllow) pass += 1;
  else {
    failures.push(
      `${method} ${url}\n      expected ${expectAllow ? 'ALLOW' : 'BLOCK'}, got ${got ? 'ALLOW' : 'BLOCK'}  (${why})`,
    );
  }
}

// The red-flag detector must actually fire, or the "shout about it" reporting
// is dead code that would never warn anyone.
const RED_FLAG_EXPECTED = [
  `${B}/api/hamilton/tailored/submit`,
  `${B}/api/hamilton/portal-sync/write`,
  `${B}/api/hamilton/automation/payment-authorizations`,
  `${B}/api/application-tasks/1/auto-submit`,
];
const missedFlags = RED_FLAG_EXPECTED.filter((u) => !classify('POST', u).redFlag);

console.log(`${pass}/${CASES.length} policy cases correct`);
console.log(`${RED_FLAG_EXPECTED.length - missedFlags.length}/${RED_FLAG_EXPECTED.length} red-flag routes detected`);

if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
if (missedFlags.length) {
  console.log('\nFAILED: these dangerous routes did not raise a red flag:');
  missedFlags.forEach((u) => console.log('  - ' + u));
  process.exit(1);
}
console.log('Mutation policy verified in both directions.');
