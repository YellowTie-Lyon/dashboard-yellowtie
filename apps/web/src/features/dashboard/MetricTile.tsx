export type Level = 'ok' | 'warning' | 'critical'

const BAR: Record<Level, string> = { ok: 'bg-white/35', warning: 'bg-orange-500', critical: 'bg-red-500' }
const VALUE: Record<Level, string> = { ok: 'text-white', warning: 'text-orange-400', critical: 'text-red-400' }
const LEVEL_LABEL: Record<Level, string> = { ok: '', warning: 'Warning', critical: 'Critical' }

/**
 * Une mesure d'un Server Cloud : le libellé, la valeur, une jauge. Rien d'autre.
 * Tant que tout est normal, la valeur reste blanche et la jauge neutre ; le jaune est réservé à la marque.
 * Orange / rouge n'apparaissent que si un seuil configuré est franchi (et le niveau est écrit en toutes lettres).
 */
export function MetricTile({ label, value, fill, level, stale }: { label: string; value: string; fill: number | null; level: Level; stale?: boolean }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${level === 'ok' ? 'border-white/10' : level === 'critical' ? 'border-red-500/50 bg-red-500/5' : 'border-orange-500/50 bg-orange-500/5'} ${stale ? 'opacity-50' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">{label}</span>
        {level !== 'ok' && <span className={`text-[11px] font-semibold uppercase ${VALUE[level]}`}>{LEVEL_LABEL[level]}</span>}
      </div>
      <div className={`mt-1 whitespace-nowrap text-2xl font-bold tabular-nums leading-tight sm:text-3xl ${VALUE[level]}`}>{value}</div>
      <div
        className="mt-2 h-1 overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fill == null ? undefined : Math.round(fill)}
      >
        <div className={`h-full rounded-full ${BAR[level]}`} style={{ width: `${Math.max(0, Math.min(100, fill ?? 0))}%` }} />
      </div>
    </div>
  )
}
