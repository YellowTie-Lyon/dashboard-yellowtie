import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ErrorNote } from '../../components/ErrorNote'
import { card, labelMono, mutedText } from '../../components/ui'
import { formatBytes, formatRelativeTime } from '../../lib/format'
import { LIVE } from '../../lib/live'
import { formatCount, formatRate, formatShare } from '../../lib/traffic'
import { useNow } from '../../lib/useNow'
import { fetchHostingTraffic } from './api'
import { TrafficChart } from './TrafficChart'

const WINDOWS = [
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 h' },
  { minutes: 360, label: '6 h' },
  { minutes: 1440, label: '24 h' },
]

const pct = (part: number, total: number) => (total > 0 ? (100 * part) / total : 0)

/** Ce qui se passe sur un hébergement : domaines, URL, IP et visiteurs, tirés de son access.log (agrégats, pas de lignes brutes). */
export function HostingTraffic({ hostingId, focusDomain, onFocus }: { hostingId: string; focusDomain: string | null; onFocus: (domain: string | null) => void }) {
  const [minutes, setMinutes] = useState(60)
  const now = useNow(30_000)
  const q = useQuery({
    queryKey: ['hosting-traffic', hostingId, minutes],
    queryFn: () => fetchHostingTraffic(hostingId, minutes),
    refetchInterval: LIVE.slow,
    placeholderData: keepPreviousData,
  })
  const t = q.data
  const total = t?.totals.requests ?? 0
  const domains = t?.domains ?? []
  const maxDomain = Math.max(1, ...domains.map((d) => d.requests))
  const paths = (t?.paths ?? []).filter((p) => !focusDomain || p.domain === focusDomain)
  const maxPath = Math.max(1, ...paths.map((p) => p.requests))
  const ips = t?.ips ?? []
  const maxIp = Math.max(1, ...ips.map((i) => i.requests))
  const agentsTotal = t ? t.agents.googlebot + t.agents.bots + t.agents.browsers + t.agents.empty : 0

  return (
    <section className="space-y-4" aria-label="Trafic">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className={labelMono}>Access.log · agrégats</p>
          <h2 className="text-2xl font-bold tracking-tight">Trafic de l'hébergement</h2>
        </div>
        <div role="group" aria-label="Période" className="flex gap-1.5">
          {WINDOWS.map((w) => (
            <button
              key={w.minutes}
              type="button"
              aria-pressed={minutes === w.minutes}
              onClick={() => setMinutes(w.minutes)}
              className={`rounded-full border px-3 py-1 text-sm font-medium ${minutes === w.minutes ? 'border-brand bg-brand text-slate-950' : 'border-white/15 hover:bg-white/10'}`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <ErrorNote error={q.error} />
      {q.isPending && <p className={mutedText}>Chargement du trafic…</p>}

      {t && total === 0 && (
        <div className={card}>
          <p className="font-medium">Aucun trafic analysé sur cette période.</p>
          <p className={`mt-1 ${mutedText}`}>
            {t.last_at
              ? `Dernière analyse ${formatRelativeTime(t.last_at, now)}.`
              : "L'analyse commence avec l'agent 0.3.1 (installé sur cet hébergement, elle s'exécute chaque minute)."}
          </p>
        </div>
      )}

      {t && total > 0 && (
        <>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="Requêtes" value={formatCount(total)} hint={formatRate(total, minutes)} />
            <Kpi label="Erreurs 5xx" value={formatShare(pct(t.totals.r5xx, total))} hint={`${t.totals.r5xx.toLocaleString('fr-FR')} requêtes`} tone={t.totals.r5xx / total > 0.05 ? 'critical' : 'ok'} />
            <Kpi label="Erreurs 4xx" value={formatShare(pct(t.totals.r4xx, total))} hint={`${t.totals.r4xx.toLocaleString('fr-FR')} requêtes`} tone={t.totals.r4xx / total > 0.3 ? 'warning' : 'ok'} />
            <Kpi label="Données servies" value={formatBytes(t.totals.bytes)} hint={`${formatShare(pct(t.totals.posts, total))} en POST`} />
          </dl>

          <div className={card}>
            <TrafficChart series={t.series} minutes={minutes} now={now} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className={card}>
              <h3 className={labelMono}>Domaines · requêtes</h3>
              <ol className="mt-3 space-y-2.5">
                {domains.slice(0, 12).map((d) => {
                  const selected = focusDomain === d.domain
                  return (
                    <li key={d.domain}>
                      <button type="button" onClick={() => onFocus(selected ? null : d.domain)} aria-pressed={selected} className="group block w-full text-left">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className={`min-w-0 truncate font-semibold group-hover:text-brand ${selected ? 'text-brand' : ''}`}>{d.domain}</span>
                          <span className="shrink-0 text-sm tabular-nums">
                            <span className="font-semibold">{formatCount(d.requests)}</span>
                            <span className="ml-2 text-xs text-slate-500">{formatShare(pct(d.requests, total))}</span>
                            {d.r5xx > 0 && <span className="ml-2 text-xs font-medium text-red-400">{formatCount(d.r5xx)} en 5xx</span>}
                          </span>
                        </div>
                        <div className="mt-1 h-1 rounded-full bg-white/10">
                          <div className={`h-full rounded-full ${selected ? 'bg-brand' : 'bg-brand/70'}`} style={{ width: `${(d.requests / maxDomain) * 100}%` }} />
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ol>
            </div>

            <div className={card}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className={labelMono}>URL les plus demandées</h3>
                {focusDomain && (
                  <button type="button" onClick={() => onFocus(null)} className="rounded-full border border-brand/50 px-2.5 py-0.5 font-mono text-xs text-brand hover:bg-brand/10">
                    {focusDomain} ✕
                  </button>
                )}
              </div>
              {paths.length === 0 ? (
                <p className={`mt-3 ${mutedText}`}>Aucune URL dans le détail conservé pour cette sélection.</p>
              ) : (
                <ol className="mt-3 space-y-2.5">
                  {paths.slice(0, 12).map((p) => (
                    <li key={`${p.domain}${p.path}`}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate font-mono text-sm" title={`${p.domain}${p.path}`}>
                          {!focusDomain && <span className="mr-1.5 text-slate-500">{p.domain}</span>}
                          {p.path}
                        </span>
                        <span className="shrink-0 text-sm tabular-nums">
                          <span className="font-semibold">{formatCount(p.requests)}</span>
                          {p.errors > 0 && <span className="ml-2 text-xs font-medium text-orange-400">{formatCount(p.errors)} en erreur</span>}
                        </span>
                      </div>
                      <div className="mt-1 h-1 rounded-full bg-white/10">
                        <div className="h-full rounded-full bg-brand/70" style={{ width: `${(p.requests / maxPath) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className={card}>
              <h3 className={labelMono}>Visiteurs</h3>
              <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-white/10" role="img" aria-label="Répartition des visiteurs">
                {(
                  [
                    ['Navigateurs', t.agents.browsers, 'bg-brand'],
                    ['Googlebot', t.agents.googlebot, 'bg-sky-400'],
                    ['Autres robots', t.agents.bots, 'bg-orange-500'],
                    ['Sans identifiant', t.agents.empty, 'bg-slate-500'],
                  ] as const
                ).map(([label, n, color]) => (
                  <div key={label} className={color} style={{ width: `${pct(n, agentsTotal)}%` }} title={`${label} : ${n}`} />
                ))}
              </div>
              <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                {(
                  [
                    ['Navigateurs', t.agents.browsers, 'bg-brand'],
                    ['Googlebot', t.agents.googlebot, 'bg-sky-400'],
                    ['Autres robots', t.agents.bots, 'bg-orange-500'],
                    ['Sans identifiant', t.agents.empty, 'bg-slate-500'],
                  ] as const
                ).map(([label, n, color]) => (
                  <li key={label} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-slate-300">
                      <span aria-hidden className={`size-2.5 rounded-sm ${color}`} />
                      {label}
                    </span>
                    <span className="tabular-nums">{formatShare(pct(n, agentsTotal))}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className={card}>
              <h3 className={labelMono}>Adresses IP les plus actives</h3>
              <ol className="mt-3 space-y-2.5">
                {ips.slice(0, 8).map((i) => (
                  <li key={i.ip}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-mono text-sm">{i.ip}</span>
                      <span className="text-sm font-semibold tabular-nums">{formatCount(i.requests)}</span>
                    </div>
                    <div className="mt-1 h-1 rounded-full bg-white/10">
                      <div className="h-full rounded-full bg-brand/70" style={{ width: `${(i.requests / maxIp) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-xs text-slate-500">Les adresses IP ne sont conservées que 3 jours.</p>
            </div>
          </div>

          <p className="text-xs text-slate-500">
            {t.sampled && "Log très volumineux : une partie des lignes n'a pas été lue (échantillon des plus récentes). "}
            Ces chiffres comptent des requêtes ; un domaine ou une URL très sollicités sont « potentiellement impliqués » dans une charge, pas
            forcément sa cause. {t.last_at ? `Dernière analyse ${formatRelativeTime(t.last_at, now)}.` : ''}
          </p>
        </>
      )}
    </section>
  )
}

function Kpi({ label, value, hint, tone = 'ok' }: { label: string; value: string; hint: string; tone?: 'ok' | 'warning' | 'critical' }) {
  const color = tone === 'critical' ? 'text-red-400' : tone === 'warning' ? 'text-orange-400' : 'text-white'
  const border = tone === 'critical' ? 'border-red-500/50' : tone === 'warning' ? 'border-orange-500/50' : 'border-white/10'
  return (
    <div className={`rounded-xl border px-4 py-3 ${border}`}>
      <dt className={labelMono}>{label}</dt>
      <dd className={`mt-1 whitespace-nowrap text-2xl font-bold tabular-nums leading-tight sm:text-3xl ${color}`}>{value}</dd>
      <p className="text-xs text-slate-500">{hint}</p>
    </div>
  )
}
