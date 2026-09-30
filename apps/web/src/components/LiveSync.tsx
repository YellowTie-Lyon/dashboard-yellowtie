import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { LIVE_SYNC_MS } from '../lib/live'

/**
 * Minuteur unique de l'actualisation : recharge toutes les requêtes de l'écran affiché d'un seul coup.
 * Une requête peut s'en exclure avec `meta: { static: true }` (donnée figée, par exemple un incident clos).
 */
export function LiveSync() {
  const queryClient = useQueryClient()
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void queryClient.refetchQueries({ type: 'active', predicate: (q) => q.meta?.static !== true })
    }, LIVE_SYNC_MS)
    return () => window.clearInterval(id)
  }, [queryClient])
  return null
}
