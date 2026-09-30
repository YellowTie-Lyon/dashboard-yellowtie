import { Link } from 'react-router-dom'

export interface DomainTraffic {
  domain: string
  hostingId: string | null
  hostingName: string | null
  requests: number
}

/**
 * Domaines ayant reçu le plus de requêtes (comptage brut, jamais une cause : « potentiellement impliqué »).
 * Le panneau reste vide tant que l'analyse des logs (agent 0.3.0) n'envoie rien.
 */
export function TopDomains({ rows }: { rows: DomainTraffic[] | null }) {
  const max = Math.max(1, ...(rows ?? []).map((r) => r.requests))
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-slate-400">Top 10 domaines · requêtes</h3>
      {rows === null || rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">
          Pas encore de données de trafic. Elles apparaîtront après l'installation de l'agent 0.3.0.
        </p>
      ) : (
        <ol className="mt-2 space-y-1.5">
          {rows.map((r, i) => (
            <li key={r.domain} className="text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate">
                  <span className="mr-2 text-slate-500 tabular-nums">{i + 1}</span>
                  {r.hostingId ? (
                    <Link to={`/hostings/${r.hostingId}`} className="hover:underline" title={r.hostingName ?? undefined}>
                      {r.domain}
                    </Link>
                  ) : (
                    r.domain
                  )}
                </span>
                <span className="font-medium tabular-nums">{r.requests.toLocaleString('fr-FR')}</span>
              </div>
              <div className="mt-0.5 h-1 rounded-full bg-slate-800">
                <div className="h-full rounded-full bg-yellow-400" style={{ width: `${(r.requests / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
