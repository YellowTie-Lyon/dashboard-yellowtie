import { getSupabase } from '../../lib/supabase'
import type {
  CloudServer,
  CloudState,
  CloudWithCounts,
  HostingState,
  ImportSitesResult,
  Site,
  WebHosting,
} from '../../lib/types'

// Toutes les fonctions lèvent l'erreur PostgREST telle quelle ; l'UI la traduit via errorMessage().

export interface CloudInput {
  name: string
  slug: string
  cpu_cores: number | null
  offline_after_seconds: number
  maintenance: boolean
  notes: string | null
}

export interface HostingInput {
  name: string
  technical_id: string | null
  access_log_path: string
  probe_url: string | null
  is_active: boolean
}

export async function fetchClouds(): Promise<CloudWithCounts[]> {
  const { data, error } = await getSupabase()
    .from('cloud_servers')
    .select('*, web_hostings(id, name, sites(count))')
    .order('name')
  if (error) throw error
  return data as CloudWithCounts[]
}

export async function fetchCloud(id: string): Promise<CloudServer | null> {
  const { data, error } = await getSupabase().from('cloud_servers').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data as CloudServer | null
}

export async function createCloud(workspaceId: string, input: CloudInput): Promise<CloudServer> {
  const { data, error } = await getSupabase()
    .from('cloud_servers')
    .insert({ workspace_id: workspaceId, ...input })
    .select()
    .single()
  if (error) throw error
  return data as CloudServer
}

export async function updateCloud(id: string, input: CloudInput): Promise<void> {
  const { error } = await getSupabase().from('cloud_servers').update(input).eq('id', id)
  if (error) throw error
}

export async function deleteCloud(id: string): Promise<void> {
  const { error } = await getSupabase().from('cloud_servers').delete().eq('id', id)
  if (error) throw error
}

export async function fetchHostings(cloudId: string): Promise<(WebHosting & { sites: { count: number }[] })[]> {
  const { data, error } = await getSupabase()
    .from('web_hostings')
    .select('*, sites(count)')
    .eq('cloud_server_id', cloudId)
    .order('name')
  if (error) throw error
  return data as (WebHosting & { sites: { count: number }[] })[]
}

export async function fetchHosting(id: string): Promise<WebHosting | null> {
  const { data, error } = await getSupabase().from('web_hostings').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data as WebHosting | null
}

export async function createHosting(cloudId: string, input: Omit<HostingInput, 'is_active'>): Promise<WebHosting> {
  const { data, error } = await getSupabase()
    .from('web_hostings')
    .insert({ cloud_server_id: cloudId, ...input })
    .select()
    .single()
  if (error) throw error
  return data as WebHosting
}

export async function updateHosting(id: string, input: HostingInput): Promise<void> {
  const { error } = await getSupabase().from('web_hostings').update(input).eq('id', id)
  if (error) throw error
}

export async function deleteHosting(id: string): Promise<void> {
  const { error } = await getSupabase().from('web_hostings').delete().eq('id', id)
  if (error) throw error
}

export async function setSystemCollector(hostingId: string): Promise<void> {
  const { error } = await getSupabase().rpc('set_system_collector', { _hosting_id: hostingId })
  if (error) throw error
}

/** Retourne le token EN CLAIR : à n'afficher qu'une fois, jamais à conserver. */
export async function rotateHostingToken(hostingId: string, graceMinutes: number): Promise<string> {
  const { data, error } = await getSupabase().rpc('rotate_hosting_token', {
    _hosting_id: hostingId,
    _grace_minutes: graceMinutes,
  })
  if (error) throw error
  return data as string
}

export async function revokeHostingToken(hostingId: string): Promise<void> {
  const { error } = await getSupabase().rpc('revoke_hosting_token', { _hosting_id: hostingId })
  if (error) throw error
}

export async function fetchSites(hostingId: string): Promise<Site[]> {
  const { data, error } = await getSupabase()
    .from('sites')
    .select('*')
    .eq('web_hosting_id', hostingId)
    .order('domain')
  if (error) throw error
  return data as Site[]
}

export async function importSites(hostingId: string, text: string): Promise<ImportSitesResult> {
  const domains = text.split(/[\s,;]+/).filter(Boolean)
  const { data, error } = await getSupabase().rpc('import_sites', { _hosting_id: hostingId, _domains: domains })
  if (error) throw error
  return data as ImportSitesResult
}

export async function setSiteActive(siteId: string, isActive: boolean): Promise<void> {
  const { error } = await getSupabase().from('sites').update({ is_active: isActive }).eq('id', siteId)
  if (error) throw error
}

export async function deleteSite(siteId: string): Promise<void> {
  const { error } = await getSupabase().from('sites').delete().eq('id', siteId)
  if (error) throw error
}

export const sitesCount = (rows: { sites: { count: number }[] }[]): number =>
  rows.reduce((total, row) => total + (row.sites[0]?.count ?? 0), 0)

// --- État des agents et derniers relevés (alimentés par agent_heartbeat) ---------------------------------

export async function fetchCloudStates(): Promise<CloudState[]> {
  const { data, error } = await getSupabase().from('cloud_server_state').select('*')
  if (error) throw error
  return data as CloudState[]
}

export async function fetchHostingStates(hostingIds: string[]): Promise<HostingState[]> {
  if (hostingIds.length === 0) return []
  const { data, error } = await getSupabase().from('web_hosting_state').select('*').in('web_hosting_id', hostingIds)
  if (error) throw error
  return data as HostingState[]
}

/** Migration vers un nouveau serveur : le Cloud oublie son hostname et son nombre de cœurs (réappris au prochain relevé). */
export async function resetCloudIdentity(cloudId: string): Promise<void> {
  const { error } = await getSupabase().rpc('reset_cloud_identity', { _cloud_id: cloudId })
  if (error) throw error
}
