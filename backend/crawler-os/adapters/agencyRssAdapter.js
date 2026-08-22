// crawler-os/adapters/agencyRssAdapter.js
//
// Generic agency RSS funding-feed adapter. Many federal agencies publish their
// funding opportunities as a key-free RSS/XML feed BEFORE (or instead of) a
// Grants.gov synopsis. This adapter turns any such feed into PROGRAM candidates
// whose info_url is the canonical agency notice page.
//
// It reuses the pipeline's existing 'html' parser family (a dependency-free
// regex list extractor) against RSS <item> blocks — no new parser, no XML
// dependency. The feed URL and provenance come from the registry row, so the
// SAME adapter serves any vetted agency feed; the first wired instance is the
// NIH Guide for Grants & Contracts funding-opportunities feed.
//
// Self-contained: imports only from within crawler-os.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';

// Match one <item>…</item> block, then pull fields from inside it.
export function rssParseCfg() {
  return {
    rowPattern: /<item[\s\S]*?<\/item>/gi,
    fieldPatterns: {
      title: /<title>([\s\S]*?)<\/title>/i,
      info_url: /<link>([\s\S]*?)<\/link>/i,
      summary: /<description>([\s\S]*?)<\/description>/i,
      pub_date: /<pubDate>([\s\S]*?)<\/pubDate>/i,
    },
  };
}

// RSS text fields are frequently wrapped in CDATA and/or carry HTML entities and
// tags. Strip them so titles/summaries are clean plain text and links are bare
// URLs. Pure + defensive (never throws on odd input).
function clean(value, { stripTags = false } = {}) {
  if (value == null) return null;
  let s = String(value);
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'); // unwrap CDATA
  // Decode entities BEFORE stripping tags: decoding after strip lets inert
  // encoded text ("&lt;script&gt;") reappear as a live tag the strip step
  // already ran past (js/double-escaping + js/bad-tag-filter).
  s = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  if (stripTags) s = s.replace(/<[^>]+>/g, ' ');       // drop HTML tags
  s = s.replace(/\s+/g, ' ').trim();
  return s.length ? s : null;
}

// Normalize a feed item link to https. The NIH Guide RSS feed emits its item
// <link>s as `http://grants.nih.gov/...` (verified live 2026-08-22), and the
// reality gate hard-rejects any http URL as BAD_URL (an intentional no-downgrade
// security floor added 2026-08-06). That silently zeroed the entire nih_guide
// lane — every candidate rejected `all_candidates_rejected:bad_url` — for every
// research-leaning profile (Axiom BioLabs and peers). grants.nih.gov serves the
// exact same notice pages over https (the http link 301->https to a 200), so a
// scheme upgrade is a faithful normalization, not a reachability guess. Only a
// bare `http://` scheme is upgraded; https and any other scheme are untouched.
function httpsUpgrade(url) {
  const u = typeof url === 'string' ? url.trim() : '';
  if (/^http:\/\//i.test(u)) return u.replace(/^http:\/\//i, 'https://');
  return u || null;
}

export function createAgencyRssAdapter() {
  return createBaseAdapter({
    source_id: 'nih_guide',
    family: 'html', // reuse the regex list parser against RSS <item> blocks
    requiredEnv: [], // public feed, no key
    buildRequests(_thesis, source) {
      const feedUrl = source?.feed_url || source?.base_url;
      if (!feedUrl) return [];
      return [{ url: feedUrl, query: 'rss', parseCfg: rssParseCfg() }];
    },
    mapCandidate(raw, { source } = {}) {
      if (!raw) return null;
      const title = clean(raw.title);
      const infoUrl = httpsUpgrade(clean(raw.info_url));
      if (!title || !infoUrl) return null;
      // info_url is scheme-normalized to https above (the feed emits http links);
      // the reality gate re-validates the URL and rejects anything unsafe.
      return {
        external_id: infoUrl, // RSS items have no stable id; the link is canonical
        kind: OPPORTUNITY_KIND.PROGRAM,
        title,
        sponsor: source?.sponsor_name || 'U.S. National Institutes of Health',
        summary: clean(raw.summary, { stripTags: true }),
        deadline: null,
        is_rolling: false,
        apply_url: null,        // PROGRAM: the agency notice IS the info_url
        info_url: infoUrl,
        applicant_types: source?.applicant_types ?? ['nonprofit', 'school', 'government', 'business'],
        need_categories: source?.need_categories ?? ['*'],
        geography: source?.geography ?? { national: true, states: [] },
        is_loan: false,
        requires_cost_share: false,
        raw,
      };
    },
  });
}

export default { createAgencyRssAdapter, rssParseCfg };
