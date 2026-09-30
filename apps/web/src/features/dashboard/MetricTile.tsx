import { Sparkline } from '../../components/Sparkline'

export type Level = 'ok' | 'warning' | 'critical'

const BAR: Record<Level, string> = { ok: 'bg-yellow-400', warning: 'bg-orange-500', critical: 'bg-red-500' }
const TEXT: Record<Level, string> = { ok: '', warning: 'text-orange-400', critical: 'text-red-400' }
const LEVEL_LABEL: Record<Level, string> = { ok: '', warning: 'Warning', critical: 'Critical' }

/**
 * Une mesure d'un Server Cloud : grande valeur, jauge et tendance de la dernière heure.
 * Le niveau (jaune / orange / rouge) vient des seuils configurés, jamais d'une valeur en dur ; il est aussi écrit en toutes lettres.
 */
export function MetricTile({
  label,
  value,
  detail,
  fill,
  level,
  trend,
  trendMax,
  stale,
}: {
  label: string
  value: string
  detail?: string
  /** Remplissage de la jauge, 0–100. */
  fill: number | null
  level: Level
  trend?: (number | null)[]
  trendMax?: number
  stale?: boolean
}) {
  return (
    <div className={`rounded-lg border border-slate-800 bg-slate-950/60 p-3 ${stale ? 'opacity-50' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-slate-400">{label}</span>
        {level !== 'ok' && <span className={`text-xs font-semibold ${TEXT[level]}`}>{LEVEL_LABEL[level]}</span>}
      </div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${TEXT[level]}`}>{value}</div>
      {detail && <div className="text-xs text-slate-500">{detail}</div>}
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fill == null ? undefined : Math.round(fill)}
      >
        <div className={`h-full rounded-full ${BAR[level]}`} style={{ width: `${Math.max(0, Math.min(100, fill ?? 0))}%` }} />
      </div>
      {trend && (
        <div className="mt-2">
          <Sparkline values={trend} max={trendMax} label={`${label}, dernière heure`} />
        </div>
      )}
    </div>
  )
}
