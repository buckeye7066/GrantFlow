function fmt(d?: string): string {
  if (!d) return 'N/A';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function FreshnessIndicator({
  lastRetrievedAt, lastChangedAt, lastVerifiedAt,
}: {
  lastRetrievedAt?: string; lastChangedAt?: string; lastVerifiedAt?: string;
}) {
  return (
    <dl className="text-xs text-gray-600 space-y-0.5">
      <div className="flex justify-between gap-2"><dt>Retrieved:</dt><dd>{fmt(lastRetrievedAt)}</dd></div>
      <div className="flex justify-between gap-2"><dt>Changed:</dt><dd>{fmt(lastChangedAt)}</dd></div>
      <div className="flex justify-between gap-2"><dt>Verified:</dt><dd>{fmt(lastVerifiedAt)}</dd></div>
    </dl>
  );
}
