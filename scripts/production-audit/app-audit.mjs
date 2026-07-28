/**
 * GrantFlow production audit — AUTHENTICATED APPLICATION LANE (CI-safe).
 *
 * Logs into production as a dedicated, temporary, non-admin audit account and
 * records what the application actually serves that account, so visible claims
 * can be compared against the database evidence collected by db-audit.mjs.
 *
 * THE SAFETY MODEL IS DEFAULT-DENY, ENFORCED AT THE NETWORK LAYER:
 *
 *   GET / HEAD / OPTIONS ............ always allowed
 *   POST to the login/session routes  allowed (nothing is visible without it)
 *   POST /api/hamilton/portal-sync/read ... allowed ONLY when the operator
 *       explicitly named both a profile id and a portal host on the run
 *   everything else that mutates .... ABORTED before it leaves the browser
 *
 * That distinction matters: this is a route handler that aborts the request,
 * not a promise to avoid clicking the wrong button. A stray click produces a
 * logged, blocked request instead of a submitted financial-aid application.
 * Every block is recorded and reported.
 *
 * WHAT IS DELIBERATELY NOT DONE: no storageState is ever written or exported,
 * no password is ever logged, no raw HTML is captured (hidden inputs carry CSRF
 * tokens), and no portal write/push/both-direction sync is reachable at all —
 * `sync` and `write` are not conditionally allowed, they are absent from the
 * allowlist entirely.
 *
 *   node scripts/production-audit/app-audit.mjs --out ./audit-out \
 *     --profiles <id,id> [--portal-hosts a,b] [--portal-reads] [--no-screenshots]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { redact, redactString } from './redact.mjs';
import { assertAutoSubmitDisabled } from './db-audit.mjs';

// ---------------------------------------------------------------------------
// Mutation policy

/**
 * The ONLY non-GET requests permitted unconditionally. Each needs a reason:
 * without a session there is nothing to audit, and a clean logout at the end
 * is better hygiene than abandoning a live session.
 */
const MUTATION_ALLOWLIST = [
  { method: 'POST', pattern: /\/api\/auth\/password\/login(?:\?|$)/, why: 'authentication' },
  { method: 'POST', pattern: /\/api\/auth\/email\/(?:start|verify)(?:\?|$)/, why: 'authentication' },
  { method: 'POST', pattern: /\/api\/auth\/refresh(?:\?|$)/, why: 'session refresh' },
  { method: 'POST', pattern: /\/api\/auth\/logout(?:\?|$)/, why: 'clean logout' },
];

/**
 * The single mutating route this audit may use for portal work, and only when
 * explicitly requested for a named profile + host.
 *
 * `read` is anchored on purpose. `/portal-sync/write` and `/portal-sync/sync`
 * (direction "both") exist on the same router; a looser pattern such as
 * /portal-sync/ would admit all three, which is precisely the mistake this
 * audit exists to rule out.
 */
const PORTAL_READ_PATTERN = /\/api\/hamilton\/portal-sync\/read(?:\?|$)/;

/** Shapes whose mere attempt should be shouted about, not just blocked. */
const RED_FLAG = [
  /submit/i,
  /attest/i,
  /authoriz/i,
  /payment/i,
  /billing/i,
  /purchase/i,
  /checkout/i,
  /portal-sync\/(?:write|sync)/i,
  /auto-?submit/i,
  /\/approve/i,
  /\/users?\b/i,
  /credential/i,
  /vault/i,
];

/**
 * Decide a single request. Pure and exported so policy.test.mjs can prove what
 * it blocks WITHOUT launching a browser — a policy that is only ever exercised
 * live is a policy nobody has actually tested.
 */
export function classify(method, url, { allowPortalRead = false, allowedPortalHosts = [] } = {}) {
  const m = String(method || '').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return { allow: true, why: 'read' };

  const hit = MUTATION_ALLOWLIST.find((r) => r.method === m && r.pattern.test(url));
  if (hit) return { allow: true, why: hit.why };

  if (m === 'POST' && PORTAL_READ_PATTERN.test(url)) {
    if (!allowPortalRead) {
      return { allow: false, redFlag: false, why: 'portal reads not requested for this run' };
    }
    if (!allowedPortalHosts.length) {
      return { allow: false, redFlag: false, why: 'no portal host was explicitly named' };
    }
    return { allow: true, why: 'read-only portal sync (explicitly requested)' };
  }

  return { allow: false, redFlag: RED_FLAG.some((re) => re.test(url)) };
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const get = (flag, dflt = null) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const csv = (flag) =>
    (get(flag, '') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    outDir: get('--out', path.join(process.cwd(), 'audit-out')),
    profiles: csv('--profiles'),
    portalHosts: csv('--portal-hosts'),
    portalReads: argv.includes('--portal-reads'),
    screenshots: !argv.includes('--no-screenshots'),
    headed: argv.includes('--headed'),
  };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`FATAL: ${name} is not set.`);
    process.exit(2);
  }
  return v.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (process.env.GRANTFLOW_PROD_BASE_URL || 'https://app.axiombiolabs.org').replace(/\/$/, '');
  const email = requireEnv('GRANTFLOW_AUDIT_EMAIL');
  const password = requireEnv('GRANTFLOW_AUDIT_PASSWORD');

  const shotsDir = path.join(args.outDir, 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });

  // ---- HARD GATE --------------------------------------------------------
  // Before a browser exists. "Cannot verify" and "armed" are the same answer.
  console.log('Auto-submit gate:');
  const posture = await assertAutoSubmitDisabled({ baseUrl });
  if (!posture?.verified) {
    console.error(
      '\nREFUSING to open a browser against production: HAMILTON_ALLOW_AUTOSUBMIT is ' +
        'not provably disabled in the running process ' +
        `(reason: ${posture?.reason || 'allow_auto_submit is not false, or the boot id did not match'}).`,
    );
    process.exit(4);
  }
  console.log('Gate passed: auto-submit is disabled in the process serving traffic.\n');

  const allowPortalRead = args.portalReads && args.portalHosts.length > 0 && args.profiles.length > 0;
  if (args.portalReads && !allowPortalRead) {
    console.log(
      'NOTE: --portal-reads was requested but no profile id + portal host pair was named. ' +
        'Portal reads stay BLOCKED for this run.',
    );
  }

  const blocked = [];
  const allowedMutations = [];
  const consoleErrors = [];
  const failedRequests = [];

  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    // No storageState in, none out. Nothing reusable is ever written to disk.
  });

  await context.route('**/*', async (route) => {
    const req = route.request();
    const verdict = classify(req.method(), req.url(), {
      allowPortalRead,
      allowedPortalHosts: args.portalHosts,
    });
    if (verdict.allow) {
      if (req.method() !== 'GET') {
        allowedMutations.push({ method: req.method(), url: redactString(req.url()), why: verdict.why });
      }
      return route.continue();
    }
    blocked.push({
      method: req.method(),
      url: redactString(req.url()),
      redFlag: Boolean(verdict.redFlag),
      why: verdict.why || 'not on the allowlist',
    });
    if (verdict.redFlag) console.log(`  BLOCKED (RED FLAG) ${req.method()} ${redactString(req.url())}`);
    return route.abort('blockedbyclient');
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(redactString(msg.text()).slice(0, 500));
  });
  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText || '';
    // Our own aborts are already recorded as policy blocks; re-reporting them
    // as network failures would make a working control look like breakage.
    if (failure.includes('blockedbyclient')) return;
    failedRequests.push({ method: req.method(), url: redactString(req.url()), error: failure });
  });

  const steps = [];
  const step = async (name, fn) => {
    try {
      const value = await fn();
      steps.push({ name, ok: true, value: value ?? null });
      console.log(`  ok    ${name}${value ? ` — ${typeof value === 'string' ? value : ''}` : ''}`);
      return value;
    } catch (err) {
      steps.push({ name, ok: false, error: redactString(err.message) });
      console.log(`  FAIL  ${name} — ${redactString(err.message)}`);
      return null;
    }
  };

  const shot = async (name) => {
    if (!args.screenshots) return;
    await page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage: true }).catch(() => {});
  };

  /**
   * Authenticated GET issued from inside the page.
   *
   * GrantFlow authenticates with a BEARER token held in localStorage
   * (`grantflow:access-token`), not a cookie — a plain `credentials: 'include'`
   * fetch returns 401. The token is read and used entirely within the browser
   * context and is never returned to Node or written to the report; the
   * redactor would scrub it even if a response echoed it back.
   */
  const apiGet = async (pathname, profileId = null) => {
    return page.evaluate(async ({ p, pid }) => {
      try {
        const token = window.localStorage.getItem('grantflow:access-token');
        const headers = { accept: 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (pid) headers['X-Profile-Id'] = pid;
        const res = await fetch(p, { credentials: 'include', headers });
        const text = await res.text();
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = { _non_json: text.slice(0, 500) };
        }
        return { status: res.status, ok: res.ok, body };
      } catch (err) {
        return { status: 0, ok: false, error: String(err && err.message) };
      }
    }, { p: pathname, pid: profileId });
  };

  console.log('Authenticated read-only pass:');

  await step('load app', async () => {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await shot('01-landing');
    return page.url();
  });

  const signedIn = await step('sign in', async () => {
    // Two-step form: email -> "Continue with Email" -> password -> "Sign in".
    const emailInput = page.locator('input[type="email"]').first();
    await emailInput.waitFor({ timeout: 30_000 });
    await emailInput.fill(email);
    await page.locator('button[type="submit"]').first().click();

    const pw = page.locator('input[type="password"]').first();
    await pw.waitFor({ timeout: 30_000 });
    // fill() never echoes the value; the password is not logged anywhere.
    await pw.fill(password);
    await page.locator('button[type="submit"]').first().click();

    await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
    await shot('02-after-login');
    return page.url();
  });

  const me = await step('identity and scope', async () => apiGet('/api/auth/me'));

  // ---- per-profile capture ------------------------------------------------
  const profileCaptures = [];
  for (const [i, profileId] of args.profiles.entries()) {
    const capture = { profile_id: profileId };
    await step(`profile ${profileId}: funding sources`, async () => {
      capture.funding_sources = await apiGet(`/api/profiles/${profileId}/funding-sources`, profileId);
      return `status ${capture.funding_sources?.status}`;
    });
    await step(`profile ${profileId}: hamilton tasks`, async () => {
      capture.hamilton_tasks = await apiGet(`/api/hamilton/automation/tasks?profileId=${profileId}`, profileId);
      return `status ${capture.hamilton_tasks?.status}`;
    });
    await step(`profile ${profileId}: hamilton readiness / sessions`, async () => {
      capture.hamilton_readiness = await apiGet(`/api/hamilton/automation/readiness?profileId=${profileId}`, profileId);
      return `status ${capture.hamilton_readiness?.status}`;
    });
    await step(`profile ${profileId}: portal sync runs`, async () => {
      capture.portal_sync_runs = await apiGet(`/api/hamilton/portal-sync/runs?profileId=${profileId}`, profileId);
      return `status ${capture.portal_sync_runs?.status}`;
    });

    // Visual evidence of what the account is actually shown.
    await step(`profile ${profileId}: screenshot`, async () => {
      await page
        .goto(`${baseUrl}/profiles/${profileId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        .catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
      await shot(`10-profile-${String(i + 1).padStart(2, '0')}`);
      return page.url();
    });

    profileCaptures.push(capture);
  }

  // ---- Amy ---------------------------------------------------------------
  const amyVisible = await step('Amy visible status', async () => apiGet('/api/health/mission'));

  // ---- optional read-only portal sync ------------------------------------
  const portalReadResults = [];
  if (allowPortalRead) {
    for (const host of args.portalHosts) {
      for (const profileId of args.profiles) {
        await step(`portal READ ${host} (profile ${profileId})`, async () => {
          const result = await page.evaluate(
            async ({ p, h }) => {
              try {
                const token = window.localStorage.getItem('grantflow:access-token');
                const headers = { 'content-type': 'application/json', accept: 'application/json' };
                if (token) headers.Authorization = `Bearer ${token}`;
                if (p) headers['X-Profile-Id'] = p;
                const res = await fetch('/api/hamilton/portal-sync/read', {
                  method: 'POST',
                  credentials: 'include',
                  headers,
                  body: JSON.stringify({ profileId: p, portalHost: h }),
                });
                const text = await res.text();
                let body;
                try {
                  body = JSON.parse(text);
                } catch {
                  body = { _non_json: text.slice(0, 500) };
                }
                return { status: res.status, ok: res.ok, body };
              } catch (err) {
                return { status: 0, ok: false, error: String(err && err.message) };
              }
            },
            { p: profileId, h: host },
          );
          // needs_session is reported HONESTLY: no captured Hamilton session
          // means the read could not happen, which is a result, not a failure
          // to paper over.
          const needsSession =
            result?.body?.needs_session === true ||
            result?.body?.summary?.needs_session === true ||
            /needs_session/i.test(JSON.stringify(result?.body ?? {}));
          portalReadResults.push({
            portal_host: host,
            profile_id: profileId,
            status: result?.status ?? 0,
            needs_session: needsSession,
            outcome: result?.ok ? (needsSession ? 'needs_session' : 'read_completed') : 'refused_or_failed',
            body: result?.body ?? null,
          });
          return `status ${result?.status} needs_session=${needsSession}`;
        });
      }
    }
  } else {
    console.log('  skip  portal reads (not requested, or no profile+host named)');
  }

  await step('logout', async () => {
    await page.evaluate(async () => {
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      } catch {
        /* best effort */
      }
    });
    return 'session ended';
  });

  await browser.close();

  const report = {
    lane: 'application',
    base_url: baseUrl,
    finished_at: new Date().toISOString(),
    account: {
      // The address is a secret in this context (it is a GitHub environment
      // secret), so only its shape is reported.
      email: '<redacted>',
      is_admin: me?.body?.user?.is_admin ?? me?.body?.is_admin ?? null,
      accessible_profile_count: Array.isArray(me?.body?.user?.profiles)
        ? me.body.user.profiles.length
        : (Array.isArray(me?.body?.profiles) ? me.body.profiles.length : null),
    },
    posture,
    signed_in: Boolean(signedIn),
    steps,
    profiles: profileCaptures,
    amy_visible: amyVisible,
    portal_reads: {
      requested: args.portalReads,
      permitted: allowPortalRead,
      hosts: args.portalHosts,
      results: portalReadResults,
    },
    mutations_allowed: allowedMutations,
    mutations_blocked: blocked,
    red_flag_attempts: blocked.filter((b) => b.redFlag),
    console_errors: consoleErrors,
    failed_requests: failedRequests,
    screenshots_included: args.screenshots,
  };

  const outPath = path.join(args.outDir, 'application-findings.json');
  fs.writeFileSync(outPath, JSON.stringify(redact(report), null, 2));

  console.log(`\nmutating requests allowed : ${allowedMutations.length}`);
  console.log(`mutating requests blocked : ${blocked.length} (${report.red_flag_attempts.length} red-flag)`);
  console.log(`console errors            : ${consoleErrors.length}`);
  console.log(`failed requests           : ${failedRequests.length}`);
  console.log(`wrote application-findings.json`);

  const failed = steps.filter((s) => !s.ok);
  if (!signedIn) {
    console.error('\nFAILED: could not sign in — the authenticated lane produced no evidence.');
    process.exit(1);
  }
  if (failed.length) {
    console.error(`\n${failed.length} step(s) failed: ${failed.map((f) => f.name).join('; ')}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('FAILED:', redactString(err.message));
    process.exit(1);
  });
}
