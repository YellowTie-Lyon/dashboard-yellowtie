import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { LiveIndicator } from '../components/LiveIndicator'
import { Logo } from '../components/Logo'
import { CloudPanel } from '../features/dashboard/CloudPanel'
import { StatusBanner } from '../features/dashboard/StatusBanner'
import { useDashboardData } from '../features/dashboard/useDashboardData'

/**
 * Mode TV / mur d'écrans : la vue d'ensemble sans aucun bouton, en grand, prête à rester affichée toute la journée.
 * Tout est en unités relatives (rem) : la taille de base suit la largeur de l'écran (voir index.css, classe « tv »), de la
 * TV Full HD à la 4K. L'écran reste allumé (Wake Lock, si le navigateur le permet) et le curseur se masque après 5 s.
 */
export function TvPage() {
  const { clouds, now, statusByCloud, stateByCloud, hostingStateById, openIncidents } = useDashboardData()
  const [idle, setIdle] = useState(false)

  useEffect(() => {
    const root = document.documentElement
    root.classList.add('tv')
    return () => root.classList.remove('tv')
  }, [])

  // Curseur masqué après 5 s sans mouvement ; le lien « Quitter » réapparaît dès que la souris bouge.
  useEffect(() => {
    let timer = window.setTimeout(() => setIdle(true), 5000)
    const wake = () => {
      setIdle(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setIdle(true), 5000)
    }
    window.addEventListener('mousemove', wake)
    window.addEventListener('keydown', wake)
    window.addEventListener('touchstart', wake)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousemove', wake)
      window.removeEventListener('keydown', wake)
      window.removeEventListener('touchstart', wake)
    }
  }, [])

  // Empêche la mise en veille de l'écran (best effort : absent de certains navigateurs de TV).
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }
    const acquire = () => {
      if (document.visibilityState === 'visible') nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => undefined)
    }
    acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      document.removeEventListener('visibilitychange', acquire)
      void lock?.release()
    }
  }, [])

  const list = clouds.data ?? []
  return (
    <div className={`min-h-screen px-[2vw] py-[1.5vw] ${idle ? 'cursor-none' : ''}`}>
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Logo className="size-10" />
          <span className="text-2xl font-bold tracking-tight">
            Yellow<span className="text-brand">Scope</span>
          </span>
        </div>
        <div className="flex items-center gap-6">
          <LiveIndicator />
          <time className="font-mono text-2xl font-semibold tabular-nums" dateTime={new Date(now).toISOString()}>
            {new Date(now).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
          </time>
          <Link to="/" className={`rounded-full border border-white/20 px-4 py-1.5 text-sm transition-opacity ${idle ? 'pointer-events-none opacity-0' : 'opacity-100'}`}>
            Quitter le mode TV
          </Link>
        </div>
      </header>

      <main className="mt-5 space-y-5">
        {clouds.isPending && <p className="text-slate-400">Chargement…</p>}
        {list.length > 0 && (
          <>
            <StatusBanner clouds={list} statuses={statusByCloud} />
            <div className="grid gap-5 lg:grid-cols-2">
              {list.map((cloud) => (
                <CloudPanel
                  key={cloud.id}
                  cloud={cloud}
                  state={stateByCloud.get(cloud.id)}
                  status={statusByCloud.get(cloud.id)}
                  hostingStates={hostingStateById}
                  openIncidents={openIncidents.filter((i) => i.cloud_server_id === cloud.id)}
                  now={now}
                  tv
                />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
