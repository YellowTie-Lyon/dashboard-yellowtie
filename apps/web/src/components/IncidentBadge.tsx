import { INCIDENT_STATUS_LABELS } from '../lib/incidents'
import type { IncidentStatus } from '../lib/types'

const STYLES: Record<IncidentStatus, { dot: string; badge: string }> = {
  warning: { dot: 'bg-status-warning', badge: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  critical: { dot: 'bg-status-critical', badge: 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300' },
  recovery: { dot: 'bg-sky-500', badge: 'bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-300' },
  closed: { dot: 'bg-status-offline', badge: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
}

/** Statut d'un incident : Warning, Critical, Retour à la normale, Clos. Le libellé accompagne toujours la couleur. */
export function IncidentBadge({ status }: { status: IncidentStatus }) {
  const s = STYLES[status]
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${s.badge}`}>
      <span aria-hidden className={`size-2 rounded-full ${s.dot}`} />
      {INCIDENT_STATUS_LABELS[status]}
    </span>
  )
}
