import { Navigate } from 'react-router-dom'
import { UsersPanel } from '../features/users/UsersPanel'
import { useWorkspace } from '../features/workspace/useWorkspace'

/** Réservée aux propriétaires (la base refuse de toute façon la liste à tout autre profil). */
export function UsersPage() {
  const { isPending, canWrite } = useWorkspace()
  if (isPending) return <p className="text-sm text-slate-400">Chargement…</p>
  if (!canWrite) return <Navigate to="/" replace />
  return <UsersPanel />
}
