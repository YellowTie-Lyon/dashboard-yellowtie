import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ErrorNote } from '../../components/ErrorNote'
import { card, labelMono, mutedText } from '../../components/ui'
import { TRAFFIC_LABELS } from '../../lib/labels'
import { LIVE } from '../../lib/live'
import { formatCount, formatShare } from '../../lib/traffic'
import { fetchIncidentTraffic } from './api'

/**
 * Le trafic reçu pendant l'incident, par hébergement puis par domaine. Ce sont des candidats à examiner
 * (« potentiellement impliqués »), jamais un verdict : un volume élevé peut être normal (campagne, Googlebot…).
 */
export function IncidentTraffic({ incidentId, open }: { incidentId: string; open: boolean }) {
  const q = useQuery({ queryKey: ['incident-traffic', incidentId], queryFn: () => fetchIncidentTraffic(incidentId), refetchInterval: open ? LIVE.slow : false })
  const t = q.data
  const maxDomain = Math.max(1, ...(t?.domains ?? []).map((d) => d.requests))

  return (
    <div className={card}>
      <h2 className="font-semibold">{TRAFFIC_LABELS.topTraffic}</h2>
      <ErrorNote error={q.error} />
      {q.isPending && <p className={`mt-2 ${mutedText}`}>Chargement…</p>}
      {t && t.requests === 0 && (
        <p className={`mt-2 ${mutedText}`}>
          Aucun trafic analysé sur cette période (agent 0.3.1 requis, ou détail déjà purgé pour un incident ancien non figé).
        </p>
      )}
      {t && t.requests > 0 && (
        <div className="mt-3 grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className={labelMono}>{TRAFFIC_LABELS.potentialHosting}</h3>
            <ol className="mt-3 space-y-2.5">
              {t.hostings.slice(0, 5).map((h) => (
                <li key={h.hosting_id}>
                  <Link to={`/hostings/${h.hosting_id}`} className="group block">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate font-semibold group-hover:text-brand">{h.name}</span>
                      <span className="shrink-0 text-sm tabular-nums">
                        <span className="font-semibold">{formatCount(h.requests)}</span>
                        <span className="ml-2 text-xs text-slate-500">{formatShare(h.share)}</span>
                      </span>
                    </div>
                    <div className="mt-1 h-1 rounded-full bg-white/10">
                      <div className="h-full rounded-full bg-brand" style={{ width: `${h.share}%` }} />
                    </div>
                  </Link>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <h3 className={labelMono}>{TRAFFIC_LABELS.potentialDomain}</h3>
            <ol className="mt-3 space-y-2.5">
              {t.domains.slice(0, 8).map((d) => (
                <li key={`${d.hosting_id}-${d.domain}`}>
                  <Link to={`/hostings/${d.hosting_id}?domain=${encodeURIComponent(d.domain)}`} className="group block">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate">
                        <span className="font-semibold group-hover:text-brand">{d.domain}</span>
                        <span className="ml-2 text-xs text-slate-500">{d.hosting}</span>
                      </span>
                      <span className="shrink-0 text-sm tabular-nums">
                        <span className="font-semibold">{formatCount(d.requests)}</span>
                        {d.r5xx > 0 && <span className="ml-2 text-xs font-medium text-red-400">{formatCount(d.r5xx)} en 5xx</span>}
                      </span>
                    </div>
                    <div className="mt-1 h-1 rounded-full bg-white/10">
                      <div className="h-full rounded-full bg-brand/70" style={{ width: `${(d.requests / maxDomain) * 100}%` }} />
                    </div>
                  </Link>
                </li>
              ))}
            </ol>
          </div>
          {t.paths.length > 0 && (
            <div className="lg:col-span-2">
              <h3 className={labelMono}>URL les plus demandées</h3>
              <ul className="mt-2 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
                {t.paths.slice(0, 6).map((p) => (
                  <li key={`${p.domain}${p.path}`} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate font-mono" title={`${p.domain}${p.path}`}>
                      <span className="text-slate-500">{p.domain}</span>
                      {p.path}
                    </span>
                    <span className="shrink-0 tabular-nums">{formatCount(p.requests)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <p className={`mt-4 text-xs ${mutedText}`}>Comptage de requêtes pendant la période : des pistes à vérifier, pas une cause établie.</p>
    </div>
  )
}
