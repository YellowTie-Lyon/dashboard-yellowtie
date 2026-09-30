/**
 * Mini-courbe sans axes (une tendance, pas une mesure). Les valeurs manquantes coupent le trait au lieu d'être
 * interpolées. `max` fixe l'échelle (100 pour un pourcentage) ; sans lui, l'échelle suit les données.
 */
export function Sparkline({ values, max, label, className = 'h-12' }: { values: (number | null)[]; max?: number; label: string; className?: string }) {
  const W = 120
  const H = 48
  const finite = values.filter((v): v is number => v != null)
  if (finite.length < 2) return <div className={`${className} text-xs text-slate-500`}>Pas assez de données</div>
  const top = max ?? Math.max(...finite, 0.0001) * 1.1
  const x = (i: number) => (i / (values.length - 1)) * W
  const y = (v: number) => H - 1 - (Math.min(v, top) / top) * (H - 3)

  const segments: { x: number; y: number }[][] = []
  let current: { x: number; y: number }[] = []
  values.forEach((v, i) => {
    if (v == null) {
      if (current.length) segments.push(current)
      current = []
    } else current.push({ x: x(i), y: y(v) })
  })
  if (current.length) segments.push(current)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className={`${className} w-full`}>
      {segments.map((seg, k) => {
        const line = seg.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
        const last = seg[seg.length - 1]!
        const area = `${seg[0]!.x.toFixed(1)},${H} ${line} ${last.x.toFixed(1)},${H}`
        return (
          <g key={k}>
            <polygon points={area} fill="var(--color-brand)" opacity="0.12" />
            <polyline points={line} fill="none" stroke="var(--color-brand)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </g>
        )
      })}
    </svg>
  )
}
