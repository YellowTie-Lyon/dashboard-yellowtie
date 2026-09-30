import { FunctionsHttpError } from '@supabase/supabase-js'
import { getSupabase } from '../../lib/supabase'
import type { WorkspaceMember, WorkspaceRole } from '../../lib/types'

export async function fetchMembers(): Promise<WorkspaceMember[]> {
  const { data, error } = await getSupabase().rpc('list_workspace_members')
  if (error) throw error
  return (data ?? []) as WorkspaceMember[]
}

export async function setMemberRole(userId: string, role: WorkspaceRole): Promise<void> {
  const { error } = await getSupabase().rpc('set_member_role', { _user_id: userId, _role: role })
  if (error) throw error
}

export type ManageAction =
  | { action: 'invite'; email: string; role: 'owner' | 'viewer' }
  | { action: 'create'; email: string; password: string; role: 'owner' | 'viewer' }
  | { action: 'remove'; userId: string }
  | { action: 'reset_mfa'; userId: string }

/** Invitation, création directe, suppression, réinitialisation du double facteur : exécutées côté serveur (fonction Edge « manage-users »). */
export async function manageUsers(body: ManageAction): Promise<void> {
  const { error } = await getSupabase().functions.invoke('manage-users', { body })
  if (!error) return
  if (error instanceof FunctionsHttpError) {
    const payload = (await error.context.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error ?? 'Action refusée par le serveur.')
  }
  throw new Error('Le serveur est injoignable. Réessayez dans un instant.')
}
