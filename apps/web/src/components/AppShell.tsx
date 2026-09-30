import { useQuery } from '@tanstack/react-query'
import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '../features/auth/auth-context'
import { fetchOpenIncidentCount } from '../features/incidents/api'
import { LIVE } from '../lib/live'
import { Logo } from './Logo'
import { LiveIndicator } from './LiveIndicator'
import { SystemAlert } from '../features/health/SystemAlert'

const navLink =
  'flex shrink-0 items-center whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300 hover:bg-white/10 hover:text-brand'

export function AppShell() {
  const { user, signOut } = useAuth()
  const open = useQuery({ queryKey: ['incidents', 'open-count'], queryFn: fetchOpenIncidentCount, refetchInterval: LIVE.fast })
  const openCount = open.data ?? 0

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-yellow-400/30 bg-white/90 backdrop-blur dark:bg-slate-950/90">
        <div className="mx-auto flex max-w-[110rem] flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 sm:px-6 sm:py-3">
          <Link to="/" className="flex items-center gap-2.5" aria-label="YellowScope, accueil">
            <Logo />
            <span className="text-lg font-bold tracking-tight">
              Yellow<span className="text-yellow-400">Scope</span>
            </span>
          </Link>

          {/* Navigation : sur téléphone, elle passe sur sa propre ligne et défile si besoin. */}
          <nav aria-label="Navigation principale" className="order-3 -mx-1 flex w-full items-center gap-1 overflow-x-auto lg:order-none lg:mx-0 lg:w-auto lg:flex-1 lg:pl-4">
            <Link to="/" className={navLink}>Accueil</Link>
            <Link to="/incidents" className={`${navLink} gap-1.5`}>
              Incidents
              {openCount > 0 && (
                <span aria-label={`${openCount} incident(s) en cours`} className="rounded-full bg-red-600 px-1.5 text-xs font-semibold normal-case text-white">
                  {openCount}
                </span>
              )}
            </Link>
            <Link to="/reglages" className={navLink}>Réglages</Link>
            <Link to="/tv" className={`${navLink} gap-1.5`} title="Affichage plein écran pour une TV ou un mur d'écrans">
              <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-4">
                <rect x="3" y="4" width="18" height="12" rx="2" />
                <path d="M8 20h8M12 16v4" />
              </svg>
              Mode TV
            </Link>
          </nav>

          <div className="flex items-center gap-3 text-sm">
            <SystemAlert />
            <span className="hidden lg:block"><LiveIndicator /></span>
            <span className="hidden text-slate-400 xl:inline">{user?.email}</span>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-full border border-white/15 px-3 py-1.5 font-medium transition-colors hover:border-white/30 hover:bg-white/10 sm:px-4"
            >
              Déconnexion
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[110rem] px-4 py-4 sm:px-6 sm:py-6">
        <Outlet />
      </main>
    </div>
  )
}
