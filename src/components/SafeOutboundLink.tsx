import { useMemo } from 'react';

function isSafeHref(href: string): boolean {
  try {
    const u = new URL(href, window.location.origin);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return true;
  } catch {
    return false;
  }
}

export function SafeOutboundLink({
  href, children, label,
}: {
  href?: string; children: React.ReactNode; label?: string;
}) {
  const safe = useMemo(() => (href ? isSafeHref(href) : false), [href]);
  if (!href || !safe) {
    return (
      <span className="text-sm text-gray-400" aria-label="No official application link available">
        No direct link available
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-sm font-medium text-blue-700 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
      aria-label={label ?? 'Open official application page (opens in a new tab)'}
    >
      {children}
    </a>
  );
}
