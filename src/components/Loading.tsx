export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center py-12"
    >
      <span className="sr-only">{label}</span>
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-blue-700" aria-hidden="true" />
    </div>
  );
}
