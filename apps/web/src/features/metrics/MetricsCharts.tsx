import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { ErrorNote } from '../../components/ErrorNote'
import { card, mutedText } from '../../components/ui'
import { formatLoad, formatPercent, formatRelativeTime } from '../../lib/format'
import { LIVE } from '../../lib/live'
import { bandFor } from '../../lib/incidents'
import { buildRows, formatMoment, RANGES, rangeSpec } from '../../lib/series'
import type { CloudServer, SeriesRange } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { fetchIncidentsInWindow } from '../incidents/api'
import { fetchJobStates, fetchSeries } from './api'
import { ChartGrid } from './ChartGrid'

/**
 * Graphiques historiques d'un Server Cloud. Un seul filtre de période, au-dessus, pilote les quatre courbes.
 * Pendant un rechargement, le tracé précédent reste affiché (légèrement estompé) : aucun saut de mise en page.
 */
export function MetricsCharts({ cloud }: { cloud: CloudServer }) {
  const [range, setRange] = useState<SeriesRange>('24h')
  const [tableOpen, setTableOpen] = useState(false)
  const spec = rangeSpec(range)
  const now = useNow(30_000)

  const series = useQuery({
    queryKey: ['series', cloud.id, range],
    queryFn: () => fetchSeries(cloud.id, range),
    placeholderData: keepPreviousData,
    refetchInterval: range === '1h' || range === '6h' ? LIVE.normal : LIVE.slow,
  })
  const jobs = useQuery({ queryKey: ['job-states'], queryFn: fetchJobStates, refetchInterval: LIVE.slow })

  const to = series.dataUpdatedAt || now
  const from = to - spec.durationMs
  const rows = useMemo(() => buildRows(series.data ?? [], spec.stepMs), [series.data, spec.stepMs])
  const incidents = useQuery({
    queryKey: ['incident-bands', cloud.id, range],
    queryFn: () => fetchIncidentsInWindow(cloud.id, new Date(from).toISOString()),
    refetchInterval: LIVE.slow,
  })
  const bands = (incidents.data ?? []).map((i) => bandFor(i, to))
  const empty = series.isSuccess && (series.data?.length ?? 0) === 0
  const reloading = series.isFetching && series.isPlaceholderData

  const rollup = jobs.data?.find((j) => j.name === 'rollup')
  const rollupStale = jobs.isSuccess && (!rollup || now - new Date(rollup.last_run_at).getTime() > 20 * 60_000)

  const cores = cloud.cpu_cores

  return (
    <section className="space-y-4" aria-label="Graphiques historiques">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Historique</h2>
        <div role="group" aria-label="Période" className="inline-flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-700">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              aria-pressed={r.key === range}
              onClick={() => setRange(r.key)}
              className={`px-3 py-1.5 text-sm font-medium ${
                r.key === range
                  ? 'bg-slate-900 text-white dark:bg-yellow-400 dark:text-slate-900'
                  : 'bg-transparent hover:bg-white/10'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <ErrorNote error={series.error} />
      {series.isPending && <p className={mutedText}>Chargement des graphiques…</p>}

      {empty && (
        <div className={`${card} border-dashed`}>
          <p className="font-medium">Aucun relevé sur cette période.</p>
          <p className={`mt-1 ${mutedText}`}>Les courbes apparaissent dès que le collecteur système envoie ses premiers relevés.</p>
        </div>
      )}

      {series.data && !empty && (
        <div className={`grid gap-4 transition-opacity lg:grid-cols-2 ${reloading ? 'opacity-60' : ''}`}>
          <ChartGrid rows={rows} spec={spec} from={from} to={to} cores={cores} bands={bands} />
        </div>
      )}

      {series.data && !empty && (
        <details
          className={card}
          onToggle={(e) => setTableOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer font-medium">Voir les valeurs sous forme de tableau</summary>
          {tableOpen && <ValuesTable rows={rows} showPeak={spec.bucketed} />}
        </details>
      )}

      {jobs.isSuccess && (
        <p className={`text-xs ${rollupStale ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-slate-400'}`}>
          {rollupStale
            ? "L'agrégation horaire n'a pas tourné récemment (planificateur pg_cron inactif ?). Les graphiques restent calculés depuis les relevés d'une minute, conservés 35 jours."
            : `Agrégation horaire : dernière exécution ${formatRelativeTime(rollup!.last_run_at, now)}. Relevés d'une minute conservés 35 jours, agrégats horaires 400 jours.`}
        </p>
      )}
    </section>
  )
}

function ValuesTable({ rows, showPeak }: { rows: ReturnType<typeof buildRows>; showPeak: boolean }) {
  const data = rows.filter((r) => r.n > 0).slice().reverse()
  return (
    <div className="mt-3 max-h-72 overflow-auto">
      <table className="w-full text-left text-xs tabular-nums">
        <thead className="sticky top-0 bg-white text-slate-500 dark:bg-slate-900 dark:text-slate-400">
          <tr>
            <th className="py-1 pr-3 font-medium">Moment</th>
            <th className="pr-3 font-medium">Load 1 / 5 / 15 min</th>
            {showPeak && <th className="pr-3 font-medium">Pic load 1 min</th>}
            <th className="pr-3 font-medium">CPU</th>
            <th className="pr-3 font-medium">RAM</th>
            <th className="pr-3 font-medium">Swap</th>
            <th className="font-medium">Disque</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.t} className="border-t border-slate-100 dark:border-slate-800">
              <td className="py-1 pr-3">{formatMoment(r.t)}</td>
              <td className="pr-3">
                {formatLoad(r.load1)} · {formatLoad(r.load5)} · {formatLoad(r.load15)}
              </td>
              {showPeak && <td className="pr-3">{formatLoad(r.load1Max)}</td>}
              <td className="pr-3">{formatPercent(r.cpu)}</td>
              <td className="pr-3">{formatPercent(r.mem)}</td>
              <td className="pr-3">{formatPercent(r.swap)}</td>
              <td>{formatPercent(r.disk)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
