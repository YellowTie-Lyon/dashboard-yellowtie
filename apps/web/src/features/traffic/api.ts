import { getSupabase } from '../../lib/supabase'
import type { DomainTrafficRow, HostingTraffic, IncidentTraffic } from '../../lib/types'

/** Domaines les plus sollicités d'un Server Cloud (jusqu'à 100 lignes : les hébergements en sont déduits côté client). */
export async function fetchTopDomains(cloudId: string, minutes: number, limit = 100): Promise<DomainTrafficRow[]> {
  const { data, error } = await getSupabase().rpc('get_top_domains', { _cloud_server_id: cloudId, _minutes: minutes, _limit: limit })
  if (error) throw error
  return (data ?? []) as DomainTrafficRow[]
}

export async function fetchHostingTraffic(hostingId: string, minutes: number): Promise<HostingTraffic | null> {
  const { data, error } = await getSupabase().rpc('get_hosting_traffic', { _hosting_id: hostingId, _minutes: minutes })
  if (error) throw error
  return (data ?? null) as HostingTraffic | null
}

export async function fetchIncidentTraffic(incidentId: string): Promise<IncidentTraffic | null> {
  const { data, error } = await getSupabase().rpc('get_incident_traffic', { _incident_id: incidentId })
  if (error) throw error
  return (data ?? null) as IncidentTraffic | null
}
