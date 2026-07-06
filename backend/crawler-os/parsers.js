// crawler-os/parsers.js
//
// ONE parser-family dispatch. Adapters declare a family; the parser turns a fetch
// body into raw candidate objects (NOT yet reality-checked or normalized). Every
// family is honest about what it can extract; the PDF family returns [] with a
// recorded note rather than fabricating fields.
//
// Pure, no I/O.

/**
 * parseApiJson — generic JSON-list parser driven by a field map from the adapter.
 * @param {string} body raw JSON text
 * @param {object} cfg  { listPath, requiredListPath, map } where map: candidateKey -> json field
 */
export function parseApiJson(body, cfg = {}) {
  let json;
  try { json = JSON.parse(body); } catch { return parseProblem('invalid_json', cfg); }
  // listPath === '' is the explicit opt-in for APIs whose response IS the list
  // (a bare JSON array at the root, e.g. SBIR.gov solicitations).
  const rawList = cfg.listPath === '' ? json : getPath(json, cfg.listPath);
  if (rawList == null) {
    if (cfg.requiredListPath) return parseProblem('required_list_path_missing', cfg);
  }
  const list = rawList ?? [];
  if (!Array.isArray(list)) return parseProblem('list_path_not_array', cfg);
  const map = cfg.map ?? {};
  const candidates = list.map((row) => {
    const out = {};
    for (const [k, path] of Object.entries(map)) out[k] = getPath(row, path);
    return out;
  });
  return { candidates };
}

/**
 * parseDirectory — a directory/locator page yields AT MOST one honest DIRECTORY
 * candidate pointing at the locator itself. It never invents per-county "grants".
 */
export function parseDirectory(body, cfg = {}) {
  if (!cfg.directoryCandidate) return { candidates: [], note: 'no_directory_descriptor' };
  return { candidates: [{ ...cfg.directoryCandidate, is_directory: true }] };
}

/**
 * parseHtmlList — minimal, dependency-free HTML list extraction using a row regex
 * + per-field regex supplied by the adapter. Real adapters in production may swap
 * in a DOM parser; the contract (candidates[]) is identical.
 */
export function parseHtmlList(body, cfg = {}) {
  if (!cfg.rowPattern) return { candidates: [], note: 'no_row_pattern' };
  const rows = String(body).match(cfg.rowPattern) ?? [];
  const candidates = [];
  for (const row of rows) {
    const c = {};
    for (const [field, re] of Object.entries(cfg.fieldPatterns ?? {})) {
      const m = re.exec(row);
      c[field] = m ? (m[1] ?? m[0]).trim() : null;
    }
    if (Object.values(c).some((v) => v)) candidates.push(c);
  }
  return { candidates };
}

/** parsePdfNotice — honest stub. Real text extraction needs a PDF lib (host app). */
export function parsePdfNotice(/* body, cfg */) {
  return { candidates: [], note: 'pdf_parser_stub: real text extraction not wired (host app dependency)' };
}

const FAMILIES = {
  api: parseApiJson,
  directory: parseDirectory,
  html: parseHtmlList,
  pdf: parsePdfNotice,
};

/**
 * parse — dispatch to a family.
 * @param {string} family
 * @param {string} body
 * @param {object} cfg
 */
export function parse(family, body, cfg = {}) {
  const fn = FAMILIES[family];
  if (!fn) return { candidates: [], note: `unknown_family:${family}` };
  return fn(body, cfg);
}

function parseProblem(note, cfg = {}) {
  const out = { candidates: [], note };
  if (cfg.requiredListPath) out.error = 'schema_mismatch';
  return out;
}

function getPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

export default { parse, parseApiJson, parseDirectory, parseHtmlList, parsePdfNotice };
