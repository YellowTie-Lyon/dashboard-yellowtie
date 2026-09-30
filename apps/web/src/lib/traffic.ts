import type { DomainTrafficRow } from './types'

export interface HostingShare {
  hostingId: string
  name: string
  requests: number
  share: number
  errors5xx: number
}

/** Regroupe les lignes domaine/hébergement par hébergement (part du trafic du Cloud, triée). */
export function hostingShares(rows: DomainTrafficRow[]): HostingShare[] {
  const total = rows.reduce((n, r) => n + r.requests, 0)
  const byHosting = new Map<string, HostingShare>()
  for (const r of rows) {
    const h = byHosting.get(r.web_hosting_id) ?? { hostingId: r.web_hosting_id, name: r.hosting_name, requests: 0, share: 0, errors5xx: 0 }
    h.requests += r.requests
    h.errors5xx += r.r5xx
    byHosting.set(r.web_hosting_id, h)
  }
  return [...byHosting.values()]
    .map((h) => ({ ...h, share: total > 0 ? (100 * h.requests) / total : 0 }))
    .sort((a, b) => b.requests - a.requests)
}

/** Requêtes par minute, arrondies pour l'affichage (« 12 req/min », « 0,4 req/min »). */
export function formatRate(requests: number, minutes: number): string {
  const perMin = requests / Math.max(1, minutes)
  const n = perMin >= 10 ? Math.round(perMin) : Math.round(perMin * 10) / 10
  return `${n.toLocaleString('fr-FR')} req/min`
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M`
  if (n >= 10_000) return `${Math.round(n / 1000).toLocaleString('fr-FR')} k`
  return n.toLocaleString('fr-FR')
}

/** Part en pourcentage, sans décimale au-dessus de 10 %. */
export function formatShare(pct: number | null | undefined): string {
  if (pct == null) return '—'
  return `${(pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10).toLocaleString('fr-FR')} %`
}
