import { Link } from 'react-router-dom'
import { statusSummary } from '../../lib/alerts'
import type { CloudStatusRow, CloudWithCounts } from '../../lib/types'
import { sitesCount } from '../inventory/api'

/**
 * La réponse en une phrase à « est-ce que tout va bien ? ». Elle nomme le Cloud concerné et le motif ; le détail
 * (hébergement, domaine) se lit dans le panneau du Cloud.
 */
export function StatusBanner({ clouds, statuses }: { clouds: CloudWithCounts[]; statuses: Map<string, CloudStatusRow> }) {
  const problems = clouds
    .map((c) => ({ cloud: c, row: statuses.get(c.id) }))
    .filter((x) => x.row && ['critical', 'warning', 'offline'].includes(x.row.status))
    .sort((a, b) => rank(b.row!.status) - rank(a.row!.status))
  const worst = problems[0]?.row?.status
  const evaluated = clouds.some((c) => statuses.has(c.id))

  const tone =
    worst === 'critical' || worst === 'offline'
      ? { box: 'border-red-500/50 bg-red-500/10', dot: 'bg-red-500', text: 'text-red-300' }
      : worst === 'warning'
        ? { box: 'border-orange-500/50 bg-orange-500/10', dot: 'bg-orange-500', text: 'text-orange-300' }
        : evaluated
          ? { box: 'border-green-500/30 bg-green-500/5', dot: 'bg-green-500', text: 'text-green-300' }
          : { box: 'border-white/10 bg-white/[0.03]', dot: 'bg-slate-500', text: 'text-slate-300' }

  const hostings = clouds.reduce((n, c) => n + c.web_hostings.length, 0)
  const inventory = `${clouds.length} Server Cloud${clouds.length > 1 ? 's' : ''} · ${hostings} hébergement${hostings > 1 ? 's' : ''} · ${clouds.reduce((n, c) => n + sitesCount(c.web_hostings), 0)} sites`

  return (
    <div role="status" className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-2xl border px-5 py-4 ${tone.box}`}>
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden className={`mt-2 size-2.5 shrink-0 rounded-full ${tone.dot} ${worst ? 'animate-pulse' : ''}`} />
        <div className="min-w-0">
          {problems.length === 0 ? (
            <p className={`text-lg font-bold ${tone.text}`}>{evaluated ? 'Tout est normal' : 'En attente des premières données'}</p>
          ) : (
            <ul className="space-y-0.5">
              {problems.map(({ cloud, row }) => (
                <li key={cloud.id} className={`text-lg font-bold ${row!.status === 'warning' ? 'text-orange-300' : 'text-red-300'}`}>
                  <Link to={`/clouds/${cloud.id}`} className="hover:underline">
                    {cloud.name}
                  </Link>
                  <span className="font-medium"> : {statusSummary(row) ?? row!.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="font-mono text-xs uppercase tracking-wider text-slate-400">{inventory}</p>
    </div>
  )
}

function rank(status: string): number {
  return status === 'critical' ? 3 : status === 'offline' ? 2 : 1
}
