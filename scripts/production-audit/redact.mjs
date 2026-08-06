/**
 * Redaction and credential detection for the GrantFlow production audit bridge.
 *
 * This module is the single place that decides what may leave production. Both
 * audit lanes scrub through it before writing anything to disk, and
 * validate-artifact.mjs re-scans the finished artifact with the detectors
 * below — so a leak has to defeat the same rules twice, once on the way out and
 * once on the way in.
 *
 * TWO DIFFERENT JOBS, DELIBERATELY SEPARATED:
 *
 *   redact(value)      — best effort, runs on the way OUT. Replaces things that
 *                        look like contact details or credentials with tags.
 *   findSecrets(text)  — fails CLOSED, runs on the way IN. Any hit blocks the
 *                        upload entirely.
 *
 * The second is not merely the inverse of the first. A redactor that missed a
 * novel secret shape would still produce a clean-looking file; the validator
 * exists to catch exactly that case, which is why it is stricter and why it is
 * allowed to be noisy.
 *
 * THE FALSE-POSITIVE PROBLEM, AND WHY KEYWORDS ALONE CANNOT WORK:
 * an audit report legitimately contains sentences like "the password field was
 * not accessed" and "no session token was exported". A validator that failed on
 * the bare word `password` would fail every honest report, and the predictable
 * human response is to weaken it until it passes — at which point it protects
 * nothing. So bare keywords are NOT findings. A keyword becomes a finding only
 * when it appears as a KEY bound to a credential-shaped VALUE
 * (`"password": "hunter2abc"`), which is what an actual leak looks like.
 * Structural secrets (connection URIs, JWTs, PEM blocks) need no such context
 * and always fail.
 */

// ---------------------------------------------------------------------------
// Structural secrets — these are never legitimate in an audit artifact.

/** A Postgres URI carrying credentials, in either accepted scheme spelling. */
const DB_URI_RE = /\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi;

/** A JWT: three base64url segments. `eyJ` alone is too loose to act on. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

/** PEM private key blocks of any flavour (RSA, EC, OPENSSH, PKCS#8). */
const PEM_RE = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g;

/**
 * `Authorization: <anything>` and bare `Bearer <token>`.
 *
 * These consume to end-of-line rather than to the first space. An earlier
 * version stopped at whitespace, so `Authorization: Bearer sk-live-…` had only
 * the word `Bearer` replaced and the token itself survived into the artifact.
 *
 * The `(?!<)` guard makes redaction IDEMPOTENT: without it, the replacement
 * `Authorization: <redacted>` matches the pattern again, so the validator would
 * flag correctly-redacted output and no artifact could ever pass.
 */
const AUTH_HEADER_RE = /\bAuthorization\s*[:=]\s*(?![\s<])[^\n\r]+/gi;
const BEARER_RE = /\bBearer\s+(?![\s<])[A-Za-z0-9._~+/=-]{8,}/g;

/** The Railway variable name that holds the superuser connection string. */
const DB_PUBLIC_URL_RE = /\bDATABASE_(?:PUBLIC_)?URL\s*=\s*(?![\s<])\S+/gi;

/** Cookie header shapes: `Cookie: a=b; c=d` / `Set-Cookie: ...`. */
const COOKIE_HEADER_RE = /\b(?:Set-)?Cookie\s*:\s*(?![\s<])[^\n\r]+/gi;

// ---------------------------------------------------------------------------
// Personal data — redacted because the audit does not need it to be useful.

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g;
const PHONE_RE = /\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
/** Conservative US street address: number + words + a street-type suffix. */
const STREET_RE =
  /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Ct|Court|Way|Pl|Place|Ter|Terrace|Cir|Circle|Hwy|Highway)\b\.?/gi;

/**
 * Keys whose VALUE is credential material regardless of what it looks like.
 * Matched against object keys and against `key: value` / `key=value` text.
 */
const SENSITIVE_KEY_RE =
  /(pass(?:word|wd|phrase)|secret|token|api[_-]?key|access[_-]?key|cookie|storage[_-]?state|storagestate|authorization|auth[_-]?header|private[_-]?key|credential|mfa|otp|recovery[_-]?code|session[_-]?id|csrf)/i;

/**
 * A `key: "value"` / `key=value` binding in free text or serialized JSON.
 * Quote characters are captured so the redacted output keeps the surrounding
 * syntax intact instead of producing malformed JSON.
 */
const SENSITIVE_ASSIGNMENT_RE =
  /(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,40})\1(\s*[:=]\s*)(["']?)([^\s"',}\]]{8,200})\4/g;

/** Our own redaction tags, plus values that cannot carry a secret. */
const PLACEHOLDER_RE = /^(?:<[^>]*>|REDACTED|redacted|null|true|false|none|n\/a|-|)$/;

/**
 * Is this string shaped like a credential rather than a description?
 *
 * Fails CLOSED: under a sensitive key, anything that is not a recognised
 * placeholder, a number, a boolean, or a short human word is treated as a
 * secret. A UUID under `token:` is a secret even though a UUID under
 * `profile_id:` is not — the key is what makes it one.
 */
export function looksLikeCredentialValue(value) {
  if (value == null) return false;
  if (typeof value === 'number' || typeof value === 'boolean') return false;
  const s = String(value).trim();
  if (PLACEHOLDER_RE.test(s)) return false;
  if (s.length < 8) return false; // too short to be usable key material
  if (/^\d+(?:\.\d+)?$/.test(s)) return false; // pure number
  if (/^\d{4}-\d{2}-\d{2}[T\s]/.test(s)) return false; // ISO timestamp
  // A short sentence of ordinary words is prose, not a credential. Requires
  // at least two spaces so `hunter2 abc` style values are still caught.
  if (/^[A-Za-z][A-Za-z\s,.'"()/-]{7,}$/.test(s) && (s.match(/\s/g) || []).length >= 2) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Redaction (outbound)

/**
 * Scrub a single string. Order matters: structural secrets are replaced before
 * the personal-data passes, so a connection string is tagged as a database URL
 * rather than being partially eaten by the email pattern (`user:pw@host` looks
 * a little like an address).
 */
export function redactString(input) {
  if (typeof input !== 'string' || !input) return input;
  return input
    .replace(DB_URI_RE, '<database-url>')
    .replace(DB_PUBLIC_URL_RE, '<database-url>')
    .replace(PEM_RE, '<private-key>')
    .replace(JWT_RE, '<jwt>')
    // Authorization first: it eats the whole header line INCLUDING a Bearer
    // token. BEARER_RE then handles a bare `Bearer x` appearing on its own.
    .replace(AUTH_HEADER_RE, 'Authorization: <redacted>')
    .replace(BEARER_RE, 'Bearer <redacted>')
    .replace(COOKIE_HEADER_RE, 'Cookie: <redacted>')
    // Key-aware pass. Catches credential material that has no distinctive shape
    // of its own — `"storageState": "<opaque blob>"`, `password=hunter2abc` —
    // which no structural pattern can recognise. Without this, a secret is safe
    // only if it happens to look like a secret.
    .replace(SENSITIVE_ASSIGNMENT_RE, (match, kq, key, sep, vq, value) =>
      SENSITIVE_KEY_RE.test(key) && looksLikeCredentialValue(value)
        ? `${kq}${key}${kq}${sep}${vq}<redacted>${vq}`
        : match,
    )
    .replace(SSN_RE, '<ssn>')
    .replace(EMAIL_RE, '<email>')
    .replace(STREET_RE, '<address>')
    .replace(PHONE_RE, '<phone>');
}

/**
 * Recursively redact any JSON-ish value.
 *
 * `minimal` additionally drops display names, for a run that wants profile ids
 * only. Display names are kept by default because a finding that cannot be
 * tied back to a recognisable profile is very hard for a human to action.
 */
export function redact(value, { minimal = false, _seen = new WeakSet() } = {}) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;

  // Cycles would otherwise hang the walker on a self-referential object.
  if (_seen.has(value)) return '<circular>';
  _seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redact(v, { minimal, _seen }));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      // Never inspect the value: a sensitive key is redacted on the key alone.
      out[k] = '<redacted>';
      continue;
    }
    if (minimal && (k === 'display_name' || k.endsWith('_name'))) {
      out[k] = v == null ? v : '<redacted-name>';
      continue;
    }
    out[k] = redact(v, { minimal, _seen });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detection (inbound / fail-closed)

/**
 * Assignment forms in free text or JSON: `"token": "abc"`, `token=abc`.
 * Captures the key and the value so the value can be judged on its shape.
 */
const ASSIGNMENT_RE = /["']?([A-Za-z_][A-Za-z0-9_.-]{0,40})["']?\s*[:=]\s*["']?([^\s"',}\]]{1,200})["']?/g;

/**
 * Scan text for anything that must never ship. Returns a list of findings;
 * an empty list means the text passed.
 *
 * Each finding reports the RULE and a short, already-redacted excerpt — the
 * validator must be able to tell a human what tripped without reprinting the
 * secret into a CI log that is far more public than the artifact was.
 */
export function findSecrets(text, { where = '' } = {}) {
  const findings = [];
  if (typeof text !== 'string' || !text) return findings;

  const structural = [
    ['database_uri', DB_URI_RE],
    ['database_url_assignment', DB_PUBLIC_URL_RE],
    ['private_key_block', PEM_RE],
    ['jwt', JWT_RE],
    ['authorization_header', AUTH_HEADER_RE],
    ['bearer_token', BEARER_RE],
    ['cookie_header', COOKIE_HEADER_RE],
  ];
  for (const [rule, re] of structural) {
    re.lastIndex = 0;
    const hits = text.match(re);
    if (hits?.length) {
      findings.push({ rule, where, count: hits.length, excerpt: redactString(hits[0]).slice(0, 80) });
    }
  }

  // Contextual: a sensitive KEY bound to a credential-shaped VALUE.
  ASSIGNMENT_RE.lastIndex = 0;
  let m;
  const seenKeys = new Set();
  while ((m = ASSIGNMENT_RE.exec(text)) !== null) {
    const [, key, rawValue] = m;
    if (!SENSITIVE_KEY_RE.test(key)) continue;
    if (!looksLikeCredentialValue(rawValue)) continue;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    findings.push({
      rule: 'sensitive_key_with_credential_value',
      where,
      key,
      count: 1,
      excerpt: `${key}: <${rawValue.length} chars withheld>`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Self-test: proves the redactor replaces planted fixtures and the detector
// both catches real secrets AND clears ordinary report prose.
//
// Run: node scripts/production-audit/redact.mjs --self-test

const FIXTURES = [
  {
    name: 'database url',
    input: 'conn = postgresql://grantflow_auditor:s3cr3tPassw0rd@host.proxy.rlwy.net:5432/railway',
    mustNotContain: ['s3cr3tPassw0rd', 'postgresql://'],
    mustDetect: true,
  },
  {
    name: 'email',
    input: 'Contact was demo_stem_student.white@example.com for this profile',
    mustNotContain: ['demo_stem_student.white@example.com'],
    mustDetect: false,
  },
  {
    name: 'phone',
    input: 'Reachable at (615) 555-0142 during business hours',
    mustNotContain: ['555-0142'],
    mustDetect: false,
  },
  {
    name: 'jwt',
    input: 'auth=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
    mustNotContain: ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
    mustDetect: true,
  },
  {
    name: 'cookie header',
    input: 'Cookie: gf_session=abc123def456ghi789; Path=/',
    mustNotContain: ['abc123def456ghi789'],
    mustDetect: true,
  },
  {
    // The two literals below are INVENTED fixtures, not credentials. They exist
    // so the self-test can prove the redactor strips a bearer token and the
    // detector flags one. `scan:allow` is the repo's sanctioned annotation for
    // exactly this case — the alternative, splicing the string together to slip
    // past scan-secrets, would be dodging a guardrail rather than answering it,
    // and would leave the next real leak just as unscanned.
    name: 'bearer token',
    input: 'Authorization: Bearer sk-live-9f8a7b6c5d4e3f2a1b0c', // scan:allow — synthetic test fixture
    mustNotContain: ['sk-live-9f8a7b6c5d4e3f2a1b0c'], // scan:allow — synthetic test fixture
    mustDetect: true,
  },
  {
    name: 'storage state value',
    input: '{"storageState": "eyJjb29raWVzIjpbeyJuYW1lIjoic2Vzc2lvbiJ9XX0abcdef"}',
    mustNotContain: ['eyJjb29raWVzIjpbeyJuYW1lIjoic2Vzc2lvbiJ9XX0abcdef'],
    mustDetect: true,
  },
  {
    name: 'ssn',
    input: 'SSN 123-45-6789 appeared in a document field',
    mustNotContain: ['123-45-6789'],
    mustDetect: false,
  },
];

/** Report prose that MUST pass — these are the false positives that kill trust. */
const BENIGN = [
  'The password field was not accessed by this audit.',
  'No session token was exported; storageState was never retrieved.',
  'secret: <redacted>',
  'password: <redacted>',
  'The cookie banner was dismissed before the screenshot was taken.',
  'token_count: 42',
  'portal_host: studentaid.gov',
  'profile_id: 00000000-0000-4000-8000-000000000001',
  'needs_session: true',
  'matcher_version: live-recheck',
];

function selfTest() {
  let pass = 0;
  const failures = [];

  for (const f of FIXTURES) {
    const redacted = redactString(f.input);
    const leaked = f.mustNotContain.filter((s) => redacted.includes(s));
    if (leaked.length) {
      failures.push(`redact "${f.name}": still contains ${leaked.length} planted value(s)`);
    } else pass += 1;

    const detected = findSecrets(f.input).length > 0;
    if (f.mustDetect && !detected) {
      failures.push(`detect "${f.name}": validator did NOT flag a planted secret`);
    } else pass += 1;

    // The redacted form must itself be clean — otherwise redaction is theatre.
    if (findSecrets(redacted).length > 0) {
      failures.push(`detect "${f.name}": redacted output STILL trips the validator`);
    } else pass += 1;
  }

  for (const text of BENIGN) {
    const hits = findSecrets(text);
    if (hits.length) {
      failures.push(`false positive on benign text: "${text}" -> ${hits.map((h) => h.rule).join(',')}`);
    } else pass += 1;
  }

  console.log(`${pass}/${FIXTURES.length * 3 + BENIGN.length} redaction checks passed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('Redactor and detector verified in both directions.');
}

if (process.argv[1] && process.argv[1].endsWith('redact.mjs') && process.argv.includes('--self-test')) {
  selfTest();
}
