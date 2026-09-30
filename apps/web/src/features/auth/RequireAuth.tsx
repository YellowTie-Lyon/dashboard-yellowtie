import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from './auth-context'
import { MfaChallenge } from './MfaChallenge'
import { MfaEnroll } from './MfaEnroll'

export function RequireAuth() {
  const { user, loading, mfa, refreshMfa } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-slate-500" role="status">
        Chargement…
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  // Aucune page protégée n'est montrée sans code TOTP validé (et la base refuse de toute façon toute donnée en aal1).
  if (mfa === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-slate-500" role="status">
        Vérification de la session…
      </div>
    )
  }
  if (mfa === 'error') {
    return (
      <div className="grid min-h-screen place-items-center px-4 text-center text-sm">
        <div>
          <p role="alert">Impossible de vérifier votre double authentification.</p>
          <button type="button" className="mt-3 underline" onClick={() => void refreshMfa()}>
            Réessayer
          </button>
        </div>
      </div>
    )
  }
  if (mfa === 'enroll') return <MfaEnroll />
  if (mfa === 'challenge') return <MfaChallenge />

  return <Outlet />
}
