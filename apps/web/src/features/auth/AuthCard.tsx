import type { ReactNode } from 'react'
import { Logo } from '../../components/Logo'

/** Cadre commun des écrans d'authentification (connexion, double facteur, mot de passe). */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center px-4 py-8">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.03] p-6 shadow-2xl sm:p-8">
        <div className="mb-6 flex items-center gap-3">
          <Logo className="size-10" />
          <div>
            <p className="text-lg font-bold leading-tight tracking-tight">
              Yellow<span className="text-brand">Scope</span>
            </p>
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400">Accès sur invitation</p>
          </div>
        </div>
        <h1 className="text-xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
        <div className="mt-5">{children}</div>
      </div>
    </div>
  )
}
