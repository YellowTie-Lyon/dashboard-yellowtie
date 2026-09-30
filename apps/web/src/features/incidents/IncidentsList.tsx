import { Link } from 'react-router-dom'
import { IncidentBadge } from '../../components/IncidentBadge'
import { formatIncidentDuration, incidentSummary, KIND_LABELS } from '../../lib/incidents'
import { formatRelativeTime } from '../../lib/format'
import type { IncidentWithNames } from '../../lib/types'

/** Liste d'incidents (page Incidents et carte d'un Cloud). Chaque ligne ouvre le détail. */
export function IncidentsList({ incidents, now, showCloud = true }: { incidents: IncidentWithNames[]; now: number; showCloud?: boolean }) {
  return (
    <ul className="divide-y divide-slate-200 dark:divide-slate-800">
      {incidents.map((i) => (
        <li key={i.id}>
          <Link to={`/incidents/${i.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50">
            <span className="w-40 shrink-0">
              <IncidentBadge status={i.status} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">
                {KIND_LABELS[i.kind]}
                {showCloud && i.cloud_servers && <span className="font-normal text-slate-500 dark:text-slate-400"> · {i.cloud_servers.name}</span>}
                {i.web_hostings && <span className="font-normal text-slate-500 dark:text-slate-400"> · {i.web_hostings.name}</span>}
              </span>
              <span className="block text-sm text-slate-500 dark:text-slate-400">{incidentSummary(i)}</span>
            </span>
            <span className="text-right text-sm text-slate-500 dark:text-slate-400">
              <span className="block">{new Date(i.started_at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              <span className="block text-xs">
                durée {formatIncidentDuration(i, now)}
                {i.status !== 'closed' && ` · ${formatRelativeTime(i.started_at, now).replace('il y a ', 'depuis ')}`}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
