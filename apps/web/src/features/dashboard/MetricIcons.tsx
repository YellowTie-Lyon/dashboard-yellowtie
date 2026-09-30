import type { ReactNode } from 'react'

export type MetricIconName = 'load' | 'cpu' | 'ram' | 'disk'

const PATHS: Record<MetricIconName, ReactNode> = {
  // Jauge : charge du serveur
  load: (
    <>
      <path d="M4 16a8 8 0 1 1 16 0" />
      <path d="M12 16l4-5" />
      <circle cx="12" cy="16" r="1" fill="currentColor" />
    </>
  ),
  // Puce : processeur
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="0.5" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </>
  ),
  // Barrette mémoire
  ram: (
    <>
      <rect x="2.5" y="7" width="19" height="9" rx="1.5" />
      <path d="M6 16v2.5M10 16v2.5M14 16v2.5M18 16v2.5M6 10.5v2M10 10.5v2M14 10.5v2M18 10.5v2" />
    </>
  ),
  // Disque dur
  disk: (
    <>
      <path d="M4 14l2.5-8h11L20 14" />
      <rect x="4" y="14" width="16" height="6" rx="1.5" />
      <circle cx="16.5" cy="17" r="0.9" fill="currentColor" />
      <path d="M7 17h5" />
    </>
  ),
}

/** Pictogramme d'une mesure (décoratif : le libellé texte reste toujours affiché à côté). */
export function MetricIcon({ name, className = 'size-4' }: { name: MetricIconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {PATHS[name]}
    </svg>
  )
}
