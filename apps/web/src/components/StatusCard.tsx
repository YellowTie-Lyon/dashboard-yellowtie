import { reasonText } from '../lib/alerts'
import { formatRelativeTime } from '../lib/format'
import { CONNECTIVITY_LABELS, DIAGNOSIS_LABELS } from '../lib/labels'
import type { CloudStatusRow } from '../lib/types'
import { StatusBadge } from './StatusBadge'
import { card, mutedText } from './ui'

/** Statut calculé d'un Server Cloud, avec les raisons et, en cas de silence, le diagnostic (jamais une affirmation). */
export function StatusCard({ row, now }: { row: CloudStatusRow | undefined; now: number }) {
  if (!row) {
    return (
      <div className={card}>
        <h2 className="font-semibold">Statut</h2>
        <p className={`mt-1 ${mutedText}`}>Pas encore évalué (l'évaluation tourne chaque minute).</p>
      </div>
    )
  }
  const d = row.detail
  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h2 className="font-semibold">Statut</h2>
          <StatusBadge status={row.status} />
          <span className={mutedText}>depuis {formatRelativeTime(row.status_since, now).replace('il y a ', '')}</span>
        </div>
        <span className="text-xs text-slate-400">évalué {formatRelativeTime(row.evaluated_at, now)}</span>
      </div>

      {(row.status === 'warning' || row.status === 'critical') && (
        <ul className="mt-3 space-y-1 text-sm">
          {d.reasons.map((r) => (
            <li key={r.metric} className="flex items-start gap-2">
              <span
                aria-hidden
                className={`mt-1.5 size-2 shrink-0 rounded-full ${r.level === 'critical' ? 'bg-status-critical' : 'bg-status-warning'}`}
              />
              <span>
                {reasonText(r)}
                <span className="text-slate-400"> · depuis {formatRelativeTime(r.since, now).replace('il y a ', '')}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {row.status === 'normal' && (
        <p className={`mt-2 ${mutedText}`}>Toutes les règles actives sont dans leurs limites.</p>
      )}
      {row.status === 'offline' && d.offline_diagnosis && (
        <p className="mt-2 text-sm">{DIAGNOSIS_LABELS[d.offline_diagnosis]}</p>
      )}
      {row.status === 'unknown' && d.connectivity in CONNECTIVITY_LABELS && (
        <p className="mt-2 text-sm">{CONNECTIVITY_LABELS[d.connectivity as keyof typeof CONNECTIVITY_LABELS]}</p>
      )}
      {row.status === 'maintenance' && (
        <p className="mt-2 text-sm">Mode maintenance : aucune alerte n'est évaluée pour ce Server Cloud.</p>
      )}
      {d.connectivity === 'delayed' && row.status !== 'offline' && (
        <p className={`mt-2 ${mutedText}`}>{CONNECTIVITY_LABELS.delayed}</p>
      )}
    </div>
  )
}
