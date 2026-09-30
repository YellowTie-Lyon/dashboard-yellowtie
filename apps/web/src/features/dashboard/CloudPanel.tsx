import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { IncidentBadge } from '../../components/IncidentBadge'
import { Sparkline } from '../../components/Sparkline'
import { StatusBadge } from '../../components/StatusBadge'
import { labelMono } from '../../components/ui'
import { agentHealth, statusSummary } from '../../lib/alerts'
import { formatLoad, formatPercent, formatRelativeTime } from '../../lib/format'
import { LIVE } from '../../lib/live'
import { formatRate, formatShare, hostingShares } from '../../lib/traffic'
import type { CloudState, CloudStatusRow, CloudWithCounts, HostingState, Incident, Metric } from '../../lib/types'
import { fetchSeries } from '../metrics/api'
import { fetchTopDomains } from '../traffic/api'
import { MetricTile, type Level } from './MetricTile'
import { TopDomains } from './TopDomains'

// Par défaut 15 minutes : le classement suit la charge du moment, comme le load (mis à jour chaque minute).
const WINDOWS = [
  { minutes: 15, label: '15 min' },
  { minutes: 60, label: '1 h' },
]
const ACCENT: Record<string, string> = {
  critical: 'border-red-500/60',
  warning: 'border-orange-500/60',
  offline: 'border-slate-500/60',
}

function levelFor(status: CloudStatusRow | undefined, metrics: Metric[]): Level {
  let level: Level = 'ok'
  for (const r of status?.detail.reasons ?? []) {
    if (!metrics.includes(r.metric)) continue
    if (r.level === 'critical') return 'critical'
    level = 'warning'
  }
  return level
}

/**
 * Un Server Cloud en trois zones lisibles d'un coup d'œil :
 *   1. état + verdict, 2. les quatre mesures (+ tendance du load), 3. « où regarder » : hébergements puis domaines les plus sollicités.
 */
export function CloudPanel({
  cloud, state, status, hostingStates, openIncidents, now,
}: {
  cloud: CloudWithCounts
  state: CloudState | undefined
  status: CloudStatusRow | undefined
  hostingStates: Map<string, HostingState>
  openIncidents: Incident[]
  now: number
}) {
  const [windowMin, setWindowMin] = useState(15)
  const windowLabel = windowMin === 15 ? 'les 15 dernières minutes' : 'la dernière heure'
  const series = useQuery({ queryKey: ['series', cloud.id, '1h'], queryFn: () => fetchSeries(cloud.id, '1h'), refetchInterval: LIVE.normal })
  const traffic = useQuery({ queryKey: ['top-domains', cloud.id, windowMin], queryFn: () => fetchTopDomains(cloud.id, windowMin), refetchInterval: LIVE.normal })
  const p = state?.last_point
  const stale = state ? (now - new Date(state.last_received_at).getTime()) / 1000 > cloud.offline_after_seconds : false
  const overall = status?.status ?? 'unknown'
  const summary = statusSummary(status)
  const rows = traffic.data ?? []
  const shares = new Map(hostingShares(rows).map((s) => [s.hostingId, s]))
  const hostings = [...cloud.web_hostings]
    .map((h) => ({ ...h, share: shares.get(h.id) }))
    .sort((a, b) => (b.share?.requests ?? 0) - (a.share?.requests ?? 0) || a.name.localeCompare(b.name))
  const maxReq = Math.max(1, ...hostings.map((h) => h.share?.requests ?? 0))

  return (
    <article className={`rounded-2xl border bg-white/[0.03] p-6 ${ACCENT[overall] ?? 'border-white/10'}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight">
            <Link to={`/clouds/${cloud.id}`} className="hover:text-brand">{cloud.name}</Link>
          </h2>
          <p className={`mt-1 ${labelMono} ${stale ? '!text-orange-400' : ''}`}>
            {state ? `données ${formatRelativeTime(state.last_received_at, now)}${stale ? ' · silence prolongé' : ''}` : 'aucune donnée'}
            {cloud.maintenance ? ' · maintenance' : ''}
          </p>
        </div>
        <StatusBadge status={overall} />
      </header>

      {(summary || openIncidents.length > 0) && (
        <div className="mt-4 space-y-1.5">
          {summary && <p className={`text-base font-semibold ${overall === 'critical' || overall === 'offline' ? 'text-red-300' : overall === 'warning' ? 'text-orange-300' : 'text-slate-300'}`}>{summary}</p>}
          {openIncidents.slice(0, 2).map((i) => (
            <Link key={i.id} to={`/incidents/${i.id}`} className="flex items-center gap-2 text-sm hover:underline">
              <IncidentBadge status={i.status} />
              <span className="text-slate-400">incident depuis {formatRelativeTime(i.started_at, now).replace('il y a ', '')}</span>
            </Link>
          ))}
        </div>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricTile label="Load" value={formatLoad(p?.load1)} fill={p ? p.load1_per_core * 100 : null} level={levelFor(status, ['load1_per_core', 'load1', 'load5', 'load5_per_core'])} stale={stale} />
        <MetricTile label="CPU" value={formatPercent(p?.cpu_pct)} fill={p?.cpu_pct ?? null} level={levelFor(status, ['cpu_pct'])} stale={stale} />
        <MetricTile label="RAM" value={formatPercent(p?.mem_used_pct)} fill={p?.mem_used_pct ?? null} level={levelFor(status, ['mem_used_pct', 'swap_used_pct'])} stale={stale} />
        <MetricTile label="Disque" value={formatPercent(p?.disk_used_pct)} fill={p?.disk_used_pct ?? null} level={levelFor(status, ['disk_used_pct'])} stale={stale} />
      </div>

      <div className="mt-4">
        <p className={labelMono}>Load · dernière heure</p>
        <div className="mt-1"><Sparkline values={(series.data ?? []).map((x) => x.load1_avg)} label="Load, dernière heure" /></div>
      </div>

      <section className="mt-6 border-t border-white/10 pt-5" aria-label="Où regarder">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className={labelMono}>1 · Hébergements · {windowLabel}</h3>
          <div role="group" aria-label="Période du trafic" className="flex gap-1">
            {WINDOWS.map((w) => (
              <button
                key={w.minutes}
                type="button"
                aria-pressed={windowMin === w.minutes}
                onClick={() => setWindowMin(w.minutes)}
                className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${windowMin === w.minutes ? 'border-brand bg-brand text-slate-950' : 'border-white/15 text-slate-300 hover:bg-white/10'}`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
        <ul className="mt-3 space-y-2.5">
          {hostings.map((h) => {
            const health = agentHealth(hostingStates.get(h.id)?.last_seen_at, cloud.offline_after_seconds, now)
            const req = h.share?.requests ?? 0
            return (
              <li key={h.id}>
                <Link to={`/hostings/${h.id}`} className="group block">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-semibold group-hover:text-brand">
                      {h.name}
                      {health !== 'ok' && (
                        <span className={`ml-2 text-xs font-medium ${health === 'delayed' ? 'text-orange-400' : 'text-red-400'}`}>
                          {health === 'delayed' ? 'agent en retard' : health === 'silent' ? 'agent silencieux' : 'agent non installé'}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-slate-300">
                      {h.share ? `${formatRate(req, windowMin)} · ${formatShare(h.share.share)}` : <span className="text-slate-500">—</span>}
                    </span>
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${(req / maxReq) * 100}%` }} />
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>

        <h3 className={`mt-6 ${labelMono}`}>2 · Domaines les plus sollicités</h3>
        <div className="mt-3">
          {rows.length > 0 ? (
            <TopDomains rows={rows} minutes={windowMin} />
          ) : (
            <p className="text-sm text-slate-500">
              {traffic.isPending ? 'Chargement…' : "Pas encore de trafic analysé. Il apparaît dès que l'agent 0.3.1 est installé (analyse chaque minute)."}
            </p>
          )}
        </div>
        <p className="mt-4 text-xs text-slate-500">Nombre de requêtes reçues : un repère, pas une cause. Un domaine très sollicité est « potentiellement impliqué » dans une charge.</p>
      </section>
    </article>
  )
}
