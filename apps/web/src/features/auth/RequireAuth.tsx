import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from './auth-context'

export function RequireAuth() {
  const { user, loading } = useAuth()
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

  return <Outlet />
}
