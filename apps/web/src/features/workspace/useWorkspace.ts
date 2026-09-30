import { useQuery } from '@tanstack/react-query'
import { getSupabase } from '../../lib/supabase'
import type { WorkspaceRole } from '../../lib/types'
import { useAuth } from '../auth/auth-context'

export interface WorkspaceInfo {
  id: string
  name: string
  role: WorkspaceRole
}

/** Workspace de l'utilisateur connecté et son rôle. `canWrite` = propriétaire (les écritures sont revérifiées par la RLS). */
export function useWorkspace() {
  const { user } = useAuth()
  const query = useQuery({
    queryKey: ['workspace', user?.id],
    enabled: Boolean(user),
    queryFn: async (): Promise<WorkspaceInfo | null> => {
      const { data, error } = await getSupabase()
        .from('workspace_members')
        .select('role, workspaces(id, name)')
        .eq('user_id', user!.id)
        .limit(1)
      if (error) throw error
      const row = data?.[0] as { role: WorkspaceRole; workspaces: { id: string; name: string } } | undefined
      return row ? { id: row.workspaces.id, name: row.workspaces.name, role: row.role } : null
    },
  })

  return {
    workspace: query.data ?? null,
    isPending: query.isPending,
    error: query.error,
    canWrite: query.data?.role === 'owner',
  }
}
