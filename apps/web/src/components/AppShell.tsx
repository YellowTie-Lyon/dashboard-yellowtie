import { Outlet } from 'react-router-dom'
import { useAuth } from '../features/auth/auth-context'
import { LiveIndicator } from './LiveIndicator'

export function AppShell() {
  const { user, signOut } = useAuth()

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="grid size-7 place-items-center rounded-md bg-yellow-400 text-xs font-bold text-slate-900"
            >
              YS
            </span>
            <span className="font-semibold tracking-tight">YellowScope</span>
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
