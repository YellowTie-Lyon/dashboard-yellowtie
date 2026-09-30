import { useQuery } from '@tanstack/react-query'
import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '../features/auth/auth-context'
import { fetchOpenIncidentCount } from '../features/incidents/api'
import { LIVE } from '../lib/live'
import { Logo } from './Logo'
import { LiveIndicator } from './LiveIndicator'

export function AppShell() {
  const { user, signOut } = useAuth()
  const open = useQuery({ queryKey: ['incidents', 'open-count'], queryFn: fetchOpenIncidentCount, refetchInterval: LIVE.fast })
  const openCount = open.data ?? 0

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-yellow-400/30 bg-white/90 backdrop-blur dark:bg-slate-950/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <Logo />
            <Link to="/" className="text-lg font-bold tracking-tight">
              Yellow<span className="text-yellow-400">Scope</span>
            </Link>
            <Link to="/incidents" className="ml-4 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-brand dark:text-slate-300">
              Incidents
              {openCount > 0 && (
                <span
                  aria-label={`${openCount} incident(s) en cours`}
                  className="rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white"
                >
                  {openCount}
                </span>
              )}
            </Link>
            <Link to="/reglages" className="ml-2 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-brand dark:text-slate-300">
              Réglages
            </Link>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <LiveIndicator />
            <span className="hidden text-slate-500 sm:inline dark:text-slate-400">{user?.email}</span>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-md border border-slate-300 px-3 py-1.5 font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Déconnexion
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  )
}
