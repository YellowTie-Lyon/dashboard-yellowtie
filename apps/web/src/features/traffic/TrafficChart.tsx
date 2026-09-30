import { useState } from 'react'
import { formatCount } from '../../lib/traffic'
import type { HostingTraffic } from '../../lib/types'

const BUCKET_S = 300

/**
 * Requêtes par tranche de 5 minutes, empilées par famille de codes : réussies (jaune), erreurs 4xx (orange), erreurs 5xx (rouge).
 * Les tranches sans données restent vides (aucune interpolation). Un seul repère au survol, sous le titre.
 */
export function TrafficChart({ series, minutes, now }: { series: HostingTraffic['series']; minutes: number; now: number }) {
  const [hover, setHover] = useState<number | null>(null)
  const end = Math.floor(now / 1000 / BUCKET_S) * BUCKET_S
  const count = Math.max(1, Math.round((minutes * 60) / BUCKET_S))
  const byTs = new Map(series.map((p) => [p.ts, p]))
  const buckets = Array.from({ length: count }, (_, i) => {
    const ts = end - (count - 1 - i) * BUCKET_S
    const p = byTs.get(ts)
    return { ts, n: p?.n ?? 0, e4: p?.e4 ?? 0, e5: p?.e5 ?? 0 }
  })
  const max = Math.max(1, ...buckets.map((b) => b.n))
  const W = 600
  const H = 120
  const bw = W / count
  const active = hover != null ? buckets[hover] : null
  const time = (ts: number) => new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })

  return (
    <figure aria-label="Requêtes par tranche de 5 minutes">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-slate-400">
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          <Legend color="bg-brand" label="Réussies" />
          <Legend color="bg-orange-500" label="Erreurs 4xx" />
          <Legend color="bg-red-500" label="Erreurs 5xx" />
        </span>
        <span className="font-mono tabular-nums">
          {active
            ? `${time(active.ts - BUCKET_S)}–${time(active.ts)} · ${active.n.toLocaleString('fr-FR')} requêtes · ${active.e4} en 4xx · ${active.e5} en 5xx`
            : `pic ${formatCount(max)} requêtes / 5 min`}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Histogramme des requêtes" className="mt-2 h-32 w-full" onMouseLeave={() => setHover(null)}>
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--chart-axis)" />
        {buckets.map((b, i) => {
          const h = (b.n / max) * (H - 4)
          const h5 = b.n > 0 ? (b.e5 / b.n) * h : 0
          const h4 = b.n > 0 ? (b.e4 / b.n) * h : 0
          const x = i * bw + 1
          const w = Math.max(1, bw - 2)
          return (
            <g key={b.ts} onMouseEnter={() => setHover(i)}>
              <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
              <rect x={x} y={H - h} width={w} height={Math.max(0, h - h5 - h4)} fill="var(--color-brand)" opacity={hover === i ? 1 : 0.85} />
              <rect x={x} y={H - h5 - h4} width={w} height={h4} fill="#f97316" />
              <rect x={x} y={H - h5} width={w} height={h5} fill="#ef4444" />
            </g>
          )
        })}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[11px] text-slate-500">
        <span>{time(buckets[0]!.ts - BUCKET_S)}</span>
        <span>{time(end)}</span>
      </div>
    </figure>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={`inline-block size-2.5 rounded-sm ${color}`} />
      {label}
    </span>
  )
}
