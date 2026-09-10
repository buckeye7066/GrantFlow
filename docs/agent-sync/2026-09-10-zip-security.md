# September 10 ZIP dependency and consumer repair

Basis: owner-authorized portfolio security remediation; main baseline
`d48c363d2e3707dc6c6c48afae37a6aa27df798a`, Dependabot alert 120
(`GHSA-vwc7-r8mq-g2x9`, adm-zip 0.6.0). No patched adm-zip release was
listed at investigation time. Its two production consumers did not use the
advisory's extraction-to-filesystem API; this removes the affected dependency
without claiming that GrantFlow was exploited.

## Changes

- Replace adm-zip with fflate 0.8.3 in source and lockfile.
- DOCX inspection validates the central directory and ZIP64 bounds, entry
  counts, safe paths and aggregate expansion limits without extracting payloads.
  Feed fflate the same verified EOCD, preventing fake footer signatures inside
  archive comments from hiding unsafe entries or rejecting valid containers.
- Mobile bundles use per-entry ZIP streams, preserving literal `__proto__`,
  nested and Unicode names. Folder entries use DEFLATE level 0: STORED entries
  with data descriptors are incompatible with Android/Java ZipInputStream.
- Independent test fixtures/readers verify malformed metadata, path and size
  boundaries, ZIP64 and comments, exact mobile bytes and manifest/checksum rules.

## Verification

- 13 upload-validation and eight mobile-manifest tests passed. New EOCD-comment
  and Android-stream compatibility regressions were observed failing before
  their corrections.
- Java ZipInputStream and ZipFile compared all 210 members of the generated
  2.2 MB mobile bundle. The earlier STORED-folder candidate failed that check.
- Full non-Vercel release gates passed on the final six-file source change:
  Node unit 3,249 passed; bulk Vitest 9,644 passed / 14 pre-existing skips;
  serial OTP lane 67 passed; Crawler OS, build, auth/download, upload persistence,
  matching, validation and endpoint-sweep gates all completed successfully.
- The first full run hit two admin-profile startup timeouts. Both passed an
  unchanged isolated rerun and the second complete run. No test timeout, skip,
  production guard or Vercel shortcut was changed to obtain the pass.
- Independent read-only review found no remaining actionable ZIP issue after
  the two consumer corrections. Production rollout and GitHub alert closure
  require separate post-merge evidence and are not claimed here.
- `npm run check:prepush` also passed, including all listed guards, lint,
  typecheck and the production build.

## Purpose, scope and recovery

Funding/profile matching, eligibility, geographic expansion, production data,
credentials and agent schedules are unchanged. No real funding applications,
messages or app-store publication were made. Existing dirty canonical checkout
work is preserved. Revert this focused commit through the normal reviewed
workflow if needed; no data migration or stored-data rewrite is involved.
