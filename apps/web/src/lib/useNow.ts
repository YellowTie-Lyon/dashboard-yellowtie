import { useEffect, useState } from 'react'

/** Horloge qui se met à jour périodiquement, pour rafraîchir les « il y a 32 s » sans recharger les données. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
