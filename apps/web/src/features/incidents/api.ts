import { getSupabase } from '../../lib/supabase'
import type { Incident, IncidentEvent, IncidentWithNames, SeriesPoint } from '../../lib/types'

const WITH_NAMES = '*, cloud_servers(name), web_hostings(name)'

export async function fetchIncidents(opts: { cloudId?: string; limit?: number } = {}): Promise<IncidentWithNames[]> {
  let query = getSupabase().from('incidents').select(WITH_NAMES).order('started_at', { ascending: false }).limit(opts.limit ?? 200)
  if (opts.cloudId) query = query.eq('cloud_server_id', opts.cloudId)
  const { data, error } = await query
  if (error) throw error
  return data as IncidentWithNames[]
}

export async function fetchIncident(id: string): Promise<IncidentWithNames | null> {
  const { data, error } = await getSupabase().from('incidents').select(WITH_NAMES).eq('id', id).maybeSingle()
  if (error) throw error
  return data as IncidentWithNames | null
}

export async function fetchIncidentEvents(incidentId: string): Promise<IncidentEvent[]> {
  const { data, error } = await getSupabase()
    .from('incident_events')
    .select('*')
    .eq('incident_id', incidentId)
    .order('ts', { ascending: true })
    .order('id', { ascending: true })
  if (error) throw error
  return data as IncidentEvent[]
}

export async function updateIncidentNote(id: string, note: string): Promise<void> {
  const { error } = await getSupabase().from('incidents').update({ note: note.trim() || null }).eq('id', id)
  if (error) throw error
}

/** Nombre d'incidents non clos (compteur de l'en-tête). */
export async function fetchOpenIncidentCount(): Promise<number> {
  const { count, error } = await getSupabase().from('incidents').select('id', { count: 'exact', head: true }).neq('status', 'closed')
  if (error) throw error
  return count ?? 0
}

/** Incidents (hors agents) qui touchent la période affichée : zones colorées sur les graphiques. */
export async function fetchIncidentsInWindow(cloudId: string, fromIso: string): Promise<Incident[]> {
  const { data, error } = await getSupabase()
    .from('incidents')
    .select('*')
    .eq('cloud_server_id', cloudId)
    .in('kind', ['performance', 'disk', 'offline'])
    .or(`ended_at.is.null,ended_at.gte.${fromIso}`)
  if (error) throw error
  return data as Incident[]
}

export async function fetchSeriesWindow(cloudId: string, fromIso: string, toIso: string): Promise<SeriesPoint[]> {
  const { data, error } = await getSupabase().rpc('get_series_window', { _cloud_server_id: cloudId, _from: fromIso, _to: toIso })
  if (error) throw error
  return data as SeriesPoint[]
}

export async function fetchCloseMinutes(): Promise<number> {
  const { data, error } = await getSupabase().from('settings').select('value').eq('key', 'incident_close_minutes').maybeSingle()
  if (error) throw error
  const v = (data as { value: unknown } | null)?.value
  return typeof v === 'number' ? v : 5
}

export async function updateCloseMinutes(workspaceId: string, minutes: number): Promise<void> {
  // UPDATE (et non upsert) : le client n'a le droit de modifier que la colonne « value » d'un réglage déjà semé.
  const { error } = await getSupabase()
    .from('settings')
    .update({ value: minutes })
    .eq('workspace_id', workspaceId)
    .eq('key', 'incident_close_minutes')
  if (error) throw error
}
