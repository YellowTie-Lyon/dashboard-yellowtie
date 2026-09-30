import { formatLoad, formatPercent } from '../../lib/format'
import type { RangeSpec, SeriesRow } from '../../lib/series'
import { lastValue } from '../../lib/series'
import { SeriesChart, type IncidentBand, type SeriesDef } from './SeriesChart'

const S1 = 'var(--series-1)'
const S2 = 'var(--series-2)'
const S3 = 'var(--series-3)'

const LOAD: SeriesDef[] = [
  { key: 'load1', peakKey: 'load1Max', label: 'Load 1 min', color: S1 },
  { key: 'load5', label: 'Load 5 min', color: S2 },
  { key: 'load15', label: 'Load 15 min', color: S3 },
]
const CPU: SeriesDef[] = [{ key: 'cpu', peakKey: 'cpuMax', label: 'CPU', color: S1 }]
const MEM: SeriesDef[] = [
  { key: 'mem', peakKey: 'memMax', label: 'RAM', color: S1 },
  { key: 'swap', label: 'Swap', color: S2 },
]
const DISK: SeriesDef[] = [{ key: 'disk', label: 'Disque', color: S1 }]

const axisNumber = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })
const pct = (v: number) => formatPercent(v)
const axisPct = (v: number) => `${axisNumber.format(v)} %`

interface ChartGridProps {
  rows: SeriesRow[]
  spec: RangeSpec
  from: number
  to: number
  cores: number | null
  bands?: IncidentBand[]
}

/** Les quatre courbes d'un Server Cloud (load, CPU, mémoire, disque) sur une même période. */
export function ChartGrid({ rows, spec, from, to, cores, bands }: ChartGridProps) {
  return (
    <>
      <SeriesChart
        title="Load average"
        subtitle={`${spec.resolution}${cores ? ` · ${cores} vCPU (une charge de ${cores} = saturation)` : ''}`}
        series={LOAD}
        rows={rows}
        range={spec}
        from={from}
        to={to}
        domain={[0, 'auto']}
        formatValue={formatLoad}
        formatAxis={(v) => axisNumber.format(v)}
        headline={<>{formatLoad(lastValue(rows, 'load1'))}</>}
        bands={bands}
      />
      <SeriesChart
        title="CPU"
        subtitle={spec.resolution}
        series={CPU}
        rows={rows}
        range={spec}
        from={from}
        to={to}
        domain={[0, 100]}
        formatValue={pct}
        formatAxis={axisPct}
        headline={formatPercent(lastValue(rows, 'cpu'))}
        bands={bands}
      />
      <SeriesChart
        title="Mémoire"
        subtitle={spec.resolution}
        series={MEM}
        rows={rows}
        range={spec}
        from={from}
        to={to}
        domain={[0, 100]}
        formatValue={pct}
        formatAxis={axisPct}
        headline={
          <>
            {formatPercent(lastValue(rows, 'mem'))}
            <span className="ml-2 text-sm font-normal text-slate-500 dark:text-slate-400">
              swap {formatPercent(lastValue(rows, 'swap'))}
            </span>
          </>
        }
        bands={bands}
      />
      <SeriesChart
        title="Disque"
        subtitle={spec.resolution}
        series={DISK}
        rows={rows}
        range={spec}
        from={from}
        to={to}
        domain={[(min) => Math.max(0, Math.floor(min) - 1), (max) => Math.min(100, Math.ceil(max) + 1)]}
        formatValue={pct}
        formatAxis={axisPct}
        headline={formatPercent(lastValue(rows, 'disk'))}
        bands={bands}
      />
    </>
  )
}
