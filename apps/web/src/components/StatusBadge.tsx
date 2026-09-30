import { STATUS_LABELS, type ServerStatus } from '../lib/labels'

const STYLES: Record<ServerStatus, { dot: string; badge: string }> = {
  normal: {
    dot: 'bg-status-normal',
    badge: 'bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-300',
  },
  warning: {
    dot: 'bg-status-warning',
    badge: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  },
  critical: {
    dot: 'bg-status-critical',
    badge: 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300',
  },
  offline: {
    dot: 'bg-status-offline',
    badge: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  unknown: {
    dot: 'bg-slate-400',
    badge: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  },
}

/** Pastille de statut. La couleur n'est jamais le seul vecteur : le libellé est toujours affiché. */
export function StatusBadge({ status }: { status: ServerStatus }) {
  const s = STYLES[status]
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${s.badge}`}
    >
      <span aria-hidden className={`size-2 rounded-full ${s.dot}`} />
      {STATUS_LABELS[status]}
    </span>
  )
}
