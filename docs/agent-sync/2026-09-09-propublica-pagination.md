# ProPublica pagination and HTTP retry recovery

## Observed defect

Production deployment 9bae8b05-f2d9-445e-9a78-1c480a6e3f49 (main 9f21f3e)
logged repeated Yana ProPublica failures on September 9 around 20:40 UTC.
The persisted page cursor was 15, while the actual query responses reported
0, 1, 2, 4 or 8 pages. The HTTP wrapper dropped the 404 status when it threw,
so its network-error branch retried a deterministic missing page. The
integration then discarded pagination metadata needed to recover.

## Changed

The shared HTTP client preserves status and structured response evidence,
without copying Axios credentials/configuration or logging response bodies.
Real HTTP 400/401/403/404 rejections are not network retries. Existing 429 and
transient server-error retries remain.

ProPublica search preserves official num_pages/cur_page/per_page metadata.
Only a structured 404 with an empty organizations array, consistent totals,
and a current page matching the request and beyond the reported page count
is accepted as end-of-data. Arbitrary 404s, malformed payloads, and outages
remain failures, not successful empty searches.

Yana recovers once at persisted_cursor modulo this query's real page count.
Counts are scoped by query, NTEE and state; a small result set cannot reset a
larger one to page zero. Up to 512 measured bounds are cached for 15 minutes,
including genuine empty results, then re-probed so expanding result sets are
not permanently hidden. Existing global cursor advancement and EIN dedupe
remain unchanged. Foundation search and other consumers keep their original
organizations/total_results fields and gain optional pagination metadata.

## Verification

The new 20-test regression suite ran against the original files first:
12 failed and 8 passed. After the repair, all 20 passed. Together with the
existing Yana cursor and profile-driven foundation tests, 45 tests passed.
The page-15 fixture executes the actual HTTP wrapper, ProPublica integration,
and Yana mapper: the former repeated [15, 15, 15] failure now requests [15, 3]
and returns the page-3 organization; the following run requests page 0.
These are controlled response fixtures, not a fresh production discovery run.

No production profile data, paid provider configuration, or pending Railway
staged changes were modified. The federal school-district replay and
four-profile qualification refresh remain separate outstanding verification.
