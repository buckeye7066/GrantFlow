type NoticeProps = {
  kind: 'success' | 'problem';
  message: string;
  onDismiss?: () => void;
};

// A plain, friendly message banner. Green for good news, warm amber for a
// problem the user can fix. Always everyday words, never technical detail.
export default function Notice({ kind, message, onDismiss }: NoticeProps) {
  const isSuccess = kind === 'success';
  const styles = isSuccess
    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
    : 'bg-amber-50 border-amber-300 text-amber-900';

  return (
    <div
      role={isSuccess ? 'status' : 'alert'}
      className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-base ${styles}`}
    >
      <p className="font-medium">{message}</p>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-md px-2 py-1 text-sm underline underline-offset-2"
          aria-label="Dismiss this message"
        >
          Dismiss
        </button>
      ) : null}
    </div>
  );
}
