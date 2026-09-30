import type { ReactNode } from 'react'
import { Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { card, mutedText } from '../../components/ui'
import { formatMoment, formatTick, timeTicks, type RangeSpec, type SeriesRow } from '../../lib/series'

export interface SeriesDef {
  key: keyof SeriesRow
  /** Colonne du pic (maximum de la tranche), tracée en zone très claire derrière la ligne de moyenne. */
  peakKey?: keyof SeriesRow
  label: string
  /** Variable CSS de couleur de série (voir index.css). Ne sert qu'aux marques, jamais au texte. */
  color: string
}

/** Période d'incident tracée en zone colorée derrière les courbes. */
export interface IncidentBand {
  from: number
  to: number
  level: 'warning' | 'critical'
}

interface SeriesChartProps {
  title: string
  subtitle?: string
  series: SeriesDef[]
  rows: SeriesRow[]
  range: RangeSpec
  from: number
  to: number
  /** Valeur d'axe (0–100 pour un pourcentage, libre pour le load). */
  domain: [number | ((min: number) => number), number | 'auto' | ((max: number) => number)]
  formatValue: (v: number) => string
  formatAxis: (v: number) => string
  /** Valeur « actuelle » affichée en en-tête, ex. « 32 % ». */
  headline: ReactNode
  /** Incidents à matérialiser sur la période (facultatif). */
  bands?: IncidentBand[]
}

/**
 * Courbe de série temporelle : lignes de 2 px, zone de pic à 10 %, grille en filet, repère au survol qui affiche toutes
 * les séries à l'instant visé. Les interruptions de collecte coupent le trait (aucun point relié à travers un trou).
 */
export function SeriesChart({ title, subtitle, series, rows, range, from, to, domain, formatValue, formatAxis, headline, bands = [] }: SeriesChartProps) {
  const showPeak = range.bucketed
  const peaks = showPeak ? series.filter((s): s is SeriesDef & { peakKey: keyof SeriesRow } => s.peakKey !== undefined) : []
  const ticks = timeTicks(from, to, range.tickMs)

  return (
    <figure className={card} aria-label={title}>
      <figcaption className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">{title}</h3>
          {subtitle && <p className={`text-xs ${mutedText}`}>{subtitle}</p>}
        </div>
        <p className="shrink-0 text-right text-xl font-semibold leading-tight">{headline}</p>
      </figcaption>

      {series.length >= 2 || peaks.length > 0 || bands.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
          {series.map((s) => (
            <li key={s.label} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
          {(['warning', 'critical'] as const)
            .filter((level) => bands.some((b) => b.level === level))
            .map((level) => (
              <li key={level} className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-2.5 w-4 rounded-sm" style={{ background: `var(--color-status-${level})`, opacity: 0.3 }} />
                Incident {level === 'critical' ? 'Critical' : 'Warning'}
              </li>
            ))}
          {peaks.length > 0 && (
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-4 rounded-sm" style={{ background: peaks[0]?.color, opacity: 0.2 }} />
              Pic de la tranche
            </li>
          )}
        </ul>
      ) : null}

      <div className="mt-3 h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 220 }}>
          <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={1} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[from, to]}
              ticks={ticks}
              tickFormatter={(t: number) => formatTick(t, range.axis)}
              tickLine={false}
              axisLine={{ stroke: 'var(--chart-axis)' }}
              tick={{ fill: 'var(--chart-muted, #898781)', fontSize: 11 }}
              minTickGap={24}
            />
            <YAxis
              domain={domain}
              tickFormatter={formatAxis}
              tickLine={false}
              axisLine={false}
              width={58}
              tick={{ fill: 'var(--chart-muted, #898781)', fontSize: 11 }}
            />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: 'var(--chart-axis)', strokeWidth: 1 }}
              content={(props) => <ChartTooltip active={props.active} payload={props.payload} series={series} showPeak={showPeak} formatValue={formatValue} />}
            />
            {bands.map((b, i) => (
              <ReferenceArea
                key={`band-${i}`}
                x1={Math.max(b.from, from)}
                x2={Math.min(b.to, to)}
                fill={`var(--color-status-${b.level})`}
                fillOpacity={0.12}
                stroke="none"
                ifOverflow="hidden"
              />
            ))}
            {peaks.map((s) => (
              <Area
                key={`${s.label}-peak`}
                dataKey={s.peakKey}
                stroke="none"
                fill={s.color}
                fillOpacity={0.1}
                connectNulls={false}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                legendType="none"
              />
            ))}
            {series.map((s) => (
              <Line
                key={s.label}
                dataKey={s.key}
                type="linear"
                stroke={s.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                activeDot={{ r: 4, fill: s.color, stroke: 'var(--chart-surface)', strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </figure>
  )
}

interface TooltipProps {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: unknown }>
  series: SeriesDef[]
  showPeak: boolean
  formatValue: (v: number) => string
}

/** Une seule infobulle pour toutes les séries à l'instant survolé : la valeur en gras, le libellé en retrait. */
function ChartTooltip({ active, payload, series, showPeak, formatValue }: TooltipProps) {
  const row = payload?.[0]?.payload as SeriesRow | undefined
  if (!active || !row) return null

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md dark:border-slate-700 dark:bg-slate-900">
      <p className="mb-1 text-slate-500 dark:text-slate-400">{formatMoment(row.t)}</p>
      {row.n === 0 ? (
        <p className="text-slate-500 dark:text-slate-400">Aucun relevé reçu</p>
      ) : (
        <ul className="space-y-0.5">
          {series.map((s) => {
            const value = row[s.key]
            const peak = s.peakKey ? row[s.peakKey] : null
            return (
              <li key={s.label} className="flex items-center gap-2">
                <span aria-hidden className="inline-block h-0.5 w-3 shrink-0 rounded" style={{ background: s.color }} />
                <strong className="text-sm">{typeof value === 'number' ? formatValue(value) : '—'}</strong>
                <span className="text-slate-500 dark:text-slate-400">{s.label}</span>
                {showPeak && typeof peak === 'number' && (
                  <span className="text-slate-400">· pic {formatValue(peak)}</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
