import type { HostingTraffic, IncidentTraffic } from './types'

/**
 * Vue commune du trafic (d'un hébergement sur une période, ou d'un Cloud pendant un incident) sur laquelle travaillent la détection
 * de motifs, les règles Cloudflare suggérées et le rapport pour ChatGPT. Uniquement des AGRÉGATS : aucune ligne de log brute.
 */
export interface TrafficView {
  scope: string
  periodLabel: string
  minutes: number
  requests: number
  totals: { r4xx: number; r5xx: number; posts: number; bots: number } | null
  hostings: { name: string; requests: number; share: number }[]
  domains: { domain: string; hosting: string | null; requests: number; r4xx: number; r5xx: number; posts: number; bots: number }[]
  paths: { domain: string; path: string; requests: number; errors: number; posts: number }[]
  queries: { domain: string; query: string; requests: number; errors: number }[]
  uas: { ua: string; requests: number }[]
  ips: { ip: string; requests: number }[]
  ipdomains: { ip: string; domain: string; requests: number }[]
  domdetail: { domain: string; distinctPaths: number; notFound: number; denied: number }[]
  agents: { googlebot: number; bots: number; browsers: number; empty: number } | null
  sampled: boolean
  /** Vrai si les motifs de paramètres / user-agents sont disponibles (agent 0.4.0 ou plus récent). */
  detailed: boolean
}

export function fromHostingTraffic(t: HostingTraffic, scope: string, minutes: number): TrafficView {
  return {
    scope,
    periodLabel: minutes >= 1440 ? 'les dernières 24 heures' : minutes >= 60 ? `les ${minutes / 60} dernière${minutes >= 120 ? 's' : ''} heure${minutes >= 120 ? 's' : ''}` : `les ${minutes} dernières minutes`,
    minutes,
    requests: t.totals.requests,
    totals: { r4xx: t.totals.r4xx, r5xx: t.totals.r5xx, posts: t.totals.posts, bots: t.totals.bots },
    hostings: [],
    domains: t.domains.map((d) => ({ domain: d.domain, hosting: null, requests: d.requests, r4xx: d.r4xx, r5xx: d.r5xx, posts: d.posts, bots: d.bots })),
    paths: t.paths.map((p) => ({ domain: p.domain, path: p.path, requests: p.requests, errors: p.errors, posts: p.posts ?? 0 })),
    queries: t.queries ?? [],
    uas: t.uas ?? [],
    ips: t.ips,
    ipdomains: t.ipdomains ?? [],
    domdetail: (t.domdetail ?? []).map((d) => ({ domain: d.domain, distinctPaths: d.distinct_paths, notFound: d.not_found, denied: d.denied })),
    agents: t.agents,
    sampled: t.sampled,
    detailed: t.queries !== undefined || t.uas !== undefined,
  }
}

export function fromIncidentTraffic(t: IncidentTraffic, scope: string): TrafficView {
  const minutes = Math.max(1, Math.round((new Date(t.to).getTime() - new Date(t.from).getTime()) / 60_000))
  const fmt = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  return {
    scope,
    periodLabel: `la période de l'incident (du ${fmt(t.from)} au ${fmt(t.to)})`,
    minutes,
    requests: t.requests,
    totals: t.totals ?? null,
    hostings: t.hostings.map((h) => ({ name: h.name, requests: h.requests, share: h.share })),
    domains: t.domains.map((d) => ({ domain: d.domain, hosting: d.hosting, requests: d.requests, r4xx: 0, r5xx: d.r5xx, posts: 0, bots: 0 })),
    paths: t.paths.map((p) => ({ domain: p.domain, path: p.path, requests: p.requests, errors: p.errors ?? 0, posts: p.posts ?? 0 })),
    queries: t.queries ?? [],
    uas: t.uas ?? [],
    ips: t.ips ?? [],
    ipdomains: t.ipdomains ?? [],
    domdetail: (t.domdetail ?? []).map((d) => ({ domain: d.domain, distinctPaths: d.distinct_paths, notFound: d.not_found, denied: d.denied })),
    agents: null,
    sampled: false,
    detailed: t.queries !== undefined || t.uas !== undefined,
  }
}
