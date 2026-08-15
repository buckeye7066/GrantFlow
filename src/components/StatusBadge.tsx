import { cn } from '../lib/cn';

const styles: Record<string, string> = {
  open: 'bg-green-100 text-green-800 border-green-300',
  forecasted: 'bg-blue-100 text-blue-800 border-blue-300',
  recurring: 'bg-purple-100 text-purple-800 border-purple-300',
  rolling: 'bg-indigo-100 text-indigo-800 border-indigo-300',
  closed: 'bg-gray-100 text-gray-600 border-gray-300',
  canceled: 'bg-red-100 text-red-800 border-red-300',
  archived: 'bg-gray-100 text-gray-500 border-gray-200',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold', styles[status] ?? styles.closed)}
      role="status"
      aria-label={`Status: ${status}`}
    >
      {status}
    </span>
  );
}
