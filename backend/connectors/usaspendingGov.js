const USA_SPENDING_API_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';

export const CONNECTOR_ID = 'usaspending.gov';
export const CONNECTOR_NAME = 'USAspending.gov';

const DEFAULT_LIMIT = 25;
const DEFAULT_FIELDS = [
  'Award ID',
  'Recipient Name',
  'Award Amount',
  'Awarding Agency',
  'Awarding Sub Agency',
  'Start Date',
  'End Date',
  'Description',
  'Contract Award Type',
];

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== ''),
  );
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toIsoDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getAwardId(rawAward) {
  return (
    rawAward['Award ID'] ||
    rawAward.award_id ||
    rawAward.generated_unique_award_id ||
    rawAward.piid ||
    rawAward.fain ||
    rawAward.uri ||
    null
  );
}

function getAwardUrl(awardId) {
  if (!awardId) {
    return 'https://www.usaspending.gov/search';
  }

  return `https://www.usaspending.gov/award/${encodeURIComponent(awardId)}`;
}

export function buildSearchPayload(options = {}) {
  const keyword = typeof options.keyword === 'string' ? options.keyword.trim() : '';
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  const page = Number.isInteger(options.page) && options.page > 0 ? options.page : 1;

  return compactObject({
    filters: compactObject({
      keywords: keyword ? [keyword] : undefined,
      time_period: options.timePeriod || undefined,
      award_type_codes: options.awardTypeCodes || ['02', '03', '04', '05'],
      agencies: options.agencies || undefined,
      recipient_search_text: options.recipientSearchText || undefined,
    }),
    fields: options.fields || DEFAULT_FIELDS,
    page,
    limit,
    sort: options.sort || 'Award Amount',
    order: options.order || 'desc',
    subawards: false,
  });
}

export function normalizeAward(rawAward) {
  const awardId = getAwardId(rawAward);
  const title = rawAward.Description || rawAward.description || rawAward['Award ID'] || 'USAspending award';
  const amount = toNumber(rawAward['Award Amount'] || rawAward.award_amount || rawAward.total_obligation);
  const awardingAgency = rawAward['Awarding Agency'] || rawAward.awarding_agency_name || null;
  const awardingSubAgency = rawAward['Awarding Sub Agency'] || rawAward.awarding_sub_agency_name || null;
  const startDate = rawAward['Start Date'] || rawAward.period_of_performance_start_date || null;
  const endDate = rawAward['End Date'] || rawAward.period_of_performance_current_end_date || null;

  return {
    id: awardId ? `usaspending:${awardId}` : `usaspending:${crypto.randomUUID()}`,
    source: CONNECTOR_ID,
    sourceName: CONNECTOR_NAME,
    sourceId: awardId,
    title,
    description: rawAward.Description || rawAward.description || null,
    agency: awardingAgency,
    subAgency: awardingSubAgency,
    recipient: rawAward['Recipient Name'] || rawAward.recipient_name || null,
    awardAmount: amount,
    amount,
    startDate: toIsoDate(startDate),
    endDate: toIsoDate(endDate),
    deadline: toIsoDate(endDate),
    url: getAwardUrl(awardId),
    sourceUrl: getAwardUrl(awardId),
    instrumentType: rawAward['Contract Award Type'] || rawAward.type_description || null,
    provenance: {
      source: CONNECTOR_ID,
      sourceId: awardId,
      fetchedAt: new Date().toISOString(),
      url: getAwardUrl(awardId),
    },
    raw: rawAward,
  };
}

export async function fetchUSAspendingAwards(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new Error('USAspending connector requires a fetch implementation.');
  }

  const response = await fetchImpl(USA_SPENDING_API_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildSearchPayload(options)),
  });

  if (!response.ok) {
    throw new Error(`USAspending request failed with status ${response.status}`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.results) ? payload.results : [];

  return {
    source: CONNECTOR_ID,
    sourceName: CONNECTOR_NAME,
    fetchedAt: new Date().toISOString(),
    total: toNumber(payload?.page_metadata?.total) || rows.length,
    page: toNumber(payload?.page_metadata?.page) || options.page || 1,
    limit: toNumber(payload?.page_metadata?.limit) || options.limit || DEFAULT_LIMIT,
    items: rows.map(normalizeAward),
    raw: payload,
  };
}

export async function searchOpportunities(options = {}) {
  const result = await fetchUSAspendingAwards(options);
  return result.items;
}

export const connector = {
  id: CONNECTOR_ID,
  name: CONNECTOR_NAME,
  source: CONNECTOR_ID,
  search: searchOpportunities,
  fetch: fetchUSAspendingAwards,
  normalize: normalizeAward,
};

export default connector;
