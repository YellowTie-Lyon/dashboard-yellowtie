import { useState } from 'react'
import { Link } from 'react-router-dom'
import { formatCount, formatRate, formatShare } from '../../lib/traffic'
import type { DomainTrafficRow } from '../../lib/types'

/**
 * Domaines ayant reçu le plus de requêtes sur la période : un comptage, jamais une cause.
 * Cinq lignes par défaut (lisibilité) ; « Voir les 10 » déplie le reste.
 */
export function TopDomains({ rows, minutes, compact = false }: { rows: DomainTrafficRow[]; minutes: number; compact?: boolean }) {
  const [all, setAll] = useState(false)
  const top = rows.slice(0, 10)
  const shown = all && !compact ? top : top.slice(0, 5)
  const max = Math.max(1, ...top.map((r) => r.requests))
  return (
    <div>
      <ol className="space-y-2.5">
        {shown.map((r, i) => (
          <li key={`${r.web_hosting_id}-${r.domain}`}>
            <Link to={`/hostings/${r.web_hosting_id}?domain=${encodeURIComponent(r.domain)}`} className="group block">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">
                  <span className="mr-2 font-mono text-xs text-slate-500">{String(i + 1).padStart(2, '0')}</span>
                  <span className="font-semibold group-hover:text-brand">{r.domain}</span>
                  <span className="ml-2 hidden text-xs text-slate-500 sm:inline">{r.hosting_name}</span>
                </span>
                <span className="shrink-0 text-sm tabular-nums">
                  <span className="font-semibold">{formatCount(r.requests)}</span>
                  <span className="ml-2 text-xs text-slate-500"><span className="hidden sm:inline">{formatRate(r.requests, minutes)} · </span>{formatShare(r.share)}</span>
                </span>
              </div>
              <div className="mt-1 h-1 rounded-full bg-white/10">
                <div className="h-full rounded-full bg-brand" style={{ width: `${(r.requests / max) * 100}%` }} />
              </div>
            </Link>
          </li>
        ))}
      </ol>
      {top.length > 5 && !compact && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-3 font-mono text-xs uppercase tracking-wider text-brand hover:underline">
          {all ? 'Réduire' : `Voir les ${top.length}`}
        </button>
      )}
    </div>
  )
}
