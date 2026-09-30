import { formatLoad, formatMb, formatPercent, formatRelativeTime, formatUptime } from '../lib/format'
import type { CloudState } from '../lib/types'
import { card, mutedText } from './ui'

/**
 * Dernier relevé système d'un Server Cloud. Ces valeurs appartiennent au Cloud (jamais à un hébergement) et
 * servent aussi à les comparer avec la console Infomaniak avant de fixer les seuils.
 */
export function MetricsCard({ state, offlineAfterSeconds, now }: { state: CloudState | null; offlineAfterSeconds: number; now: number }) {
  if (!state) {
    return (
      <div className={card}>
        <h2 className="font-semibold">Dernier relevé système</h2>
        <p className={`mt-1 ${mutedText}`}>
          Aucun relevé reçu. Installez l'agent sur les hébergements de ce Cloud : le collecteur système enverra
          load, CPU, RAM, swap et disque chaque minute.
        </p>
      </div>
    )
  }

  const p = state.last_point
  const ageSeconds = (now - new Date(state.last_received_at).getTime()) / 1000
  const stale = ageSeconds > offlineAfterSeconds
  const rows: [string, string][] = [
    ['Load 1 / 5 / 15 min', `${formatLoad(p.load1)} · ${formatLoad(p.load5)} · ${formatLoad(p.load15)}`],
    ['Load par cœur (1 min)', `${formatLoad(p.load1_per_core)} sur ${p.cpu_cores} vCPU`],
    ['CPU', formatPercent(p.cpu_pct)],
    ['RAM', `${formatPercent(p.mem_used_pct)} (${formatMb(p.mem_used_mb)} / ${formatMb(p.mem_total_mb)})`],
    ['Swap', `${formatPercent(p.swap_used_pct)} (${formatMb(p.swap_used_mb)} / ${formatMb(p.swap_total_mb)})`],
    ['Disque', `${formatPercent(p.disk_used_pct)} (${formatMb(p.disk_used_mb)} / ${formatMb(p.disk_total_mb)})`],
    ['Uptime', formatUptime(p.uptime_s)],
  ]

  return (
    <div className={card}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Dernier relevé système</h2>
        <p className={stale ? 'text-sm font-medium text-amber-700 dark:text-amber-400' : mutedText}>
          {formatRelativeTime(state.last_received_at, now)}
          {stale && ' · silence prolongé'}
        </p>
      </div>
      <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 border-b border-slate-100 pb-1 dark:border-slate-800">
            <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
            <dd className="text-right font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <p className={`mt-3 text-xs ${mutedText}`}>
        Relevé du {new Date(p.ts * 1000).toLocaleString('fr-FR')}. Les statuts et alertes seront évalués à partir de
        la phase 5 (mode observation : comparez ces valeurs avec la console Infomaniak).
      </p>
    </div>
  )
}
