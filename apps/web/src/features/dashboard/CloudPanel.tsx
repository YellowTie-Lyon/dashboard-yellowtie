import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { IncidentBadge } from '../../components/IncidentBadge'
import { StatusBadge } from '../../components/StatusBadge'
import { agentHealth, statusSummary } from '../../lib/alerts'
import { formatLoad, formatMb, formatPercent, formatRelativeTime } from '../../lib/format'
import { LIVE } from '../../lib/live'
import { sitesCount } from '../inventory/api'
import { fetchSeries } from '../metrics/api'
import type { CloudState, CloudStatusRow, CloudWithCounts, HostingState, Incident, Metric } from '../../lib/types'
import { MetricTile, type Level } from './MetricTile'
import { TopDomains } from './TopDomains'

const ACCENT: Record<string, string> = {
  critical: 'border-red-500/60 shadow-[0_0_0_1px_rgb(239_68_68/0.25)]',
  warning: 'border-orange-500/60',
  offline: 'border-slate-600',
}
const AGENT_DOT: Record<string, string> = { ok: 'bg-status-normal', delayed: 'bg-orange-500', silent: 'bg-red-500', never: 'bg-slate-600' }
const AGENT_TEXT: Record<string, string> = { ok: 'agent actif', delayed: 'agent en retard', silent: 'agent silencieux', never: "agent non installé" }

function levelFor(status: CloudStatusRow | undefined, metrics: Metric[]): Level {
  let level: Level = 'ok'
  for (const r of status?.detail.reasons ?? []) {
    if (!metrics.includes(r.metric)) continue
    if (r.level === 'critical') return 'critical'
    level = 'warning'
  }
  return level
}

/** Vue d'ensemble d'un Server Cloud : statut, 4 mesures, tendance 1 h, hébergements et domaines les plus sollicités. */
export function CloudPanel({
  cloud,
  state,
  status,
  hostingNames,
  hostingStates,
  openIncidents,
  now,
}: {
  cloud: CloudWithCounts
  state: CloudState | undefined
  status: CloudStatusRow | undefined
  hostingNames: Map<string, string>
  hostingStates: Map<string, HostingState>
  openIncidents: Incident[]
  now: number
}) {
  // Une seule requête de 60 points par Cloud (relevés bruts de l'heure), partagée avec la page du Cloud.
  const series = useQuery({ queryKey: ['series', cloud.id, '1h'], queryFn: () => fetchSeries(cloud.id, '1h'), refetchInterval: LIVE.normal })
  const pts = series.data ?? []
  const p = state?.last_point
  const stale = state ? (now - new Date(state.last_received_at).getTime()) / 1000 > cloud.offline_after_seconds : false
  const cores = p?.cpu_cores ?? cloud.cpu_cores ?? null
  const overall = status?.status ?? 'unknown'
  const summary = statusSummary(status)
  const hostings = [...cloud.web_hostings].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <article className={`rounded-2xl border bg-slate-900 p-5 ${ACCENT[overall] ?? 'border-slate-800'}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold uppercase tracking-tight">
            <Link to={`/clouds/${cloud.id}`} className="hover:text-yellow-400">
              {cloud.name}
            </Link>
          </h2>
          <p className="text-sm text-slate-400">
            {hostings.length} hébergement{hostings.length > 1 ? 's' : ''} · {sitesCount(cloud.web_hostings)} sites
            {cores ? ` · ${cores} vCPU` : ''}
            {cloud.maintenance ? ' · maintenance' : ''}
          </p>
        </div>
        <div className="text-right">
          <StatusBadge status={overall} />
          <p className={`mt-1 text-xs ${stale ? 'font-medium text-orange-400' : 'text-slate-500'}`}>
            {state ? `${formatRelativeTime(state.last_received_at, now)}${stale ? ' · silence prolongé' : ''}` : 'aucune donnée'}
          </p>
        </div>
      </header>

      {summary && <p className={`mt-3 text-sm font-medium ${overall === 'critical' ? 'text-red-400' : overall === 'warning' ? 'text-orange-400' : 'text-slate-300'}`}>{summary}</p>}

      {openIncidents.length > 0 && (
        <ul className="mt-3 space-y-1">
          {openIncidents.slice(0, 3).map((i) => (
            <li key={i.id}>
              <Link to={`/incidents/${i.id}`} className="inline-flex items-center gap-2 text-sm hover:underline">
                <IncidentBadge status={i.status} />
                <span className="text-slate-400">incident depuis {formatRelativeTime(i.started_at, now).replace('il y a ', '')}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile
          label="Load"
          value={formatLoad(p?.load1)}
          detail={p ? `${formatLoad(p.load1_per_core)} par cœur` : undefined}
          fill={p ? p.load1_per_core * 100 : null}
          level={levelFor(status, ['load1_per_core', 'load1', 'load5', 'load5_per_core'])}
          trend={pts.map((x) => x.load1_avg)}
          stale={stale}
        />
        <MetricTile
          label="CPU"
          value={formatPercent(p?.cpu_pct)}
          fill={p?.cpu_pct ?? null}
          level={levelFor(status, ['cpu_pct'])}
          trend={pts.map((x) => x.cpu_pct_avg)}
          trendMax={100}
          stale={stale}
        />
        <MetricTile
          label="RAM"
          value={formatPercent(p?.mem_used_pct)}
          detail={p ? `${formatMb(p.mem_used_mb)} / ${formatMb(p.mem_total_mb)}` : undefined}
          fill={p?.mem_used_pct ?? null}
          level={levelFor(status, ['mem_used_pct', 'swap_used_pct'])}
          trend={pts.map((x) => x.mem_used_pct_avg)}
          trendMax={100}
          stale={stale}
        />
        <MetricTile
          label="Disque"
          value={formatPercent(p?.disk_used_pct)}
          detail={p ? `${formatMb(p.disk_used_mb)} / ${formatMb(p.disk_total_mb)}` : undefined}
          fill={p?.disk_used_pct ?? null}
          level={levelFor(status, ['disk_used_pct'])}
          stale={stale}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wider text-slate-400">Hébergements</h3>
          {hostings.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">Aucun hébergement déclaré.</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/60">
              {hostings.map((h) => {
                const health = agentHealth(hostingStates.get(h.id)?.last_seen_at, cloud.offline_after_seconds, now)
                return (
                  <li key={h.id}>
                    <Link to={`/hostings/${h.id}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-800/60">
                      <span className="min-w-0 truncate font-medium">{hostingNames.get(h.id) ?? h.name}</span>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-slate-400">
                        {h.sites[0]?.count ?? 0} sites
                        <span aria-hidden className={`size-2 rounded-full ${AGENT_DOT[health]}`} />
                        {AGENT_TEXT[health]}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <TopDomains rows={null} />
      </div>
    </article>
  )
}
