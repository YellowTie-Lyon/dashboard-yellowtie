import { getSupabase } from '../../lib/supabase'
import type { JobState, SeriesPoint, SeriesRange } from '../../lib/types'

/** Séries d'un Server Cloud (get_series choisit la source et la finesse ; au plus ~720 points). */
export async function fetchSeries(cloudId: string, range: SeriesRange): Promise<SeriesPoint[]> {
  const { data, error } = await getSupabase().rpc('get_series', { _cloud_server_id: cloudId, _range: range })
  if (error) throw error
  return data as SeriesPoint[]
}

/** Dernières exécutions de l'agrégation et de la purge (pour détecter un planificateur à l'arrêt). */
export async function fetchJobStates(): Promise<JobState[]> {
  const { data, error } = await getSupabase().from('job_state').select('*')
  if (error) throw error
  return data as JobState[]
}
