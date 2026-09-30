import { getSupabase } from '../../lib/supabase'
import type { RuleInput } from '../../lib/alerts'
import type { AlertRule, CloudStatusRow, Metric, MetricPercentiles, ProbeResult } from '../../lib/types'

export async function fetchCloudStatuses(): Promise<CloudStatusRow[]> {
  const { data, error } = await getSupabase().from('cloud_status').select('*')
  if (error) throw error
  return data as CloudStatusRow[]
}

export async function fetchAlertRules(): Promise<AlertRule[]> {
  const { data, error } = await getSupabase().from('alert_rules').select('*')
  if (error) throw error
  return data as AlertRule[]
}

export async function createRule(
  workspaceId: string,
  cloudId: string | null,
  metric: Metric,
  input: RuleInput,
): Promise<void> {
  const { error } = await getSupabase()
    .from('alert_rules')
    .insert({ workspace_id: workspaceId, cloud_server_id: cloudId, metric, ...input })
  if (error) throw error
}

export async function updateRule(id: string, input: RuleInput): Promise<void> {
  const { error } = await getSupabase().from('alert_rules').update(input).eq('id', id)
  if (error) throw error
}

export async function deleteRule(id: string): Promise<void> {
  const { error } = await getSupabase().from('alert_rules').delete().eq('id', id)
  if (error) throw error
}

/** Recalcule tout de suite les statuts (sinon le prochain passage arrive dans la minute). */
export async function refreshStatuses(): Promise<void> {
  const { error } = await getSupabase().rpc('refresh_statuses')
  if (error) throw error
}

/** Distribution réelle des mesures d'un Cloud sur 7 jours : aide à choisir des seuils réalistes. */
export async function fetchPercentiles(cloudId: string): Promise<MetricPercentiles[]> {
  const { data, error } = await getSupabase().rpc('get_metric_percentiles', { _cloud_server_id: cloudId, _days: 7 })
  if (error) throw error
  return data as MetricPercentiles[]
}

/** Dernier résultat de sonde de chaque hébergement demandé. */
export async function fetchLatestProbes(hostingIds: string[]): Promise<Map<string, ProbeResult>> {
  if (hostingIds.length === 0) return new Map()
  const { data, error } = await getSupabase()
    .from('probe_results')
    .select('*')
    .in('web_hosting_id', hostingIds)
    .order('ts', { ascending: false })
    .limit(Math.max(50, hostingIds.length * 10))
  if (error) throw error
  const latest = new Map<string, ProbeResult>()
  for (const row of data as ProbeResult[]) if (!latest.has(row.web_hosting_id)) latest.set(row.web_hosting_id, row)
  return latest
}
