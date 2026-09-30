import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { formatRelativeTime } from '../lib/format'
import { useNow } from '../lib/useNow'

/**
 * Indique que la page se met à jour toute seule, et depuis quand. Ne considère que les requêtes de l'écran affiché
 * (celles qui ont un observateur) : une erreur sur une page quittée ne déclenche pas de fausse alerte.
 */
export function LiveIndicator() {
  const queryClient = useQueryClient()
  const fetching = useIsFetching() > 0
  const now = useNow(5_000)

  const active = queryClient
    .getQueryCache()
    .getAll()
    .filter((q) => q.getObserversCount() > 0)
  const latest = Math.max(0, ...active.map((q) => q.state.dataUpdatedAt))
  const failing = active.some((q) => q.state.status === 'error' && q.state.fetchStatus === 'idle')

  if (failing) {
    return (
      <span role="status" className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <span aria-hidden className="size-2 rounded-full bg-amber-500" />
        Connexion perdue · nouvelle tentative automatique
      </span>
    )
  }
  if (latest === 0) return null

  const stale = now - latest > 2 * 60_000
  return (
    <span role="status" className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
      <span
        aria-hidden
        className={`size-2 rounded-full ${stale ? 'bg-slate-400' : 'bg-emerald-500'} ${fetching ? 'animate-pulse' : ''}`}
      />
      {stale ? 'Actualisé' : 'En direct · actualisé'} {formatRelativeTime(latest, now)}
    </span>
  )
}
