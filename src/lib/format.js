function isNil(value) {
  return value === null || value === undefined;
}

function toNumber(value) {
  if (isNil(value) || value === '') {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function formatCurrency(value, options = {}) {
  const number = toNumber(value);

  if (number === null) {
    return options.fallback || '—';
  }

  return new Intl.NumberFormat(options.locale || 'en-US', {
    style: 'currency',
    currency: options.currency || 'USD',
    maximumFractionDigits: options.maximumFractionDigits ?? 0,
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
  }).format(number);
}

export function formatNumber(value, options = {}) {
  const number = toNumber(value);

  if (number === null) {
    return options.fallback || '—';
  }

  return new Intl.NumberFormat(options.locale || 'en-US', options).format(number);
}

export function formatPercent(value, options = {}) {
  const number = toNumber(value);

  if (number === null) {
    return options.fallback || '—';
  }

  const normalized = options.alreadyPercent ? number : number * 100;

  return new Intl.NumberFormat(options.locale || 'en-US', {
    style: 'percent',
    maximumFractionDigits: options.maximumFractionDigits ?? 1,
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
  }).format(normalized / 100);
}

export function formatDate(value, options = {}) {
  if (isNil(value) || value === '') {
    return options.fallback || '—';
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return options.fallback || '—';
  }

  return new Intl.DateTimeFormat(options.locale || 'en-US', {
    month: options.month || 'short',
    day: options.day || 'numeric',
    year: options.year || 'numeric',
  }).format(date);
}

export function formatDateTime(value, options = {}) {
  if (isNil(value) || value === '') {
    return options.fallback || '—';
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return options.fallback || '—';
  }

  return new Intl.DateTimeFormat(options.locale || 'en-US', {
    month: options.month || 'short',
    day: options.day || 'numeric',
    year: options.year || 'numeric',
    hour: options.hour || 'numeric',
    minute: options.minute || '2-digit',
  }).format(date);
}

export function formatBytes(value, options = {}) {
  const number = toNumber(value);

  if (number === null) {
    return options.fallback || '—';
  }

  if (number === 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(number) / Math.log(1024)), units.length - 1);
  const amount = number / 1024 ** index;

  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function truncate(value, maxLength = 120) {
  if (isNil(value)) {
    return '';
  }

  const text = String(value);

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function titleCase(value) {
  if (isNil(value)) {
    return '';
  }

  return String(value)
    .toLowerCase()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export default {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatDate,
  formatDateTime,
  formatBytes,
  truncate,
  titleCase,
};
