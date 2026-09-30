export type WorkspaceRole = 'owner' | 'admin' | 'viewer'

export interface CloudServer {
  id: string
  workspace_id: string
  name: string
  slug: string
  provider: string
  cpu_cores: number | null
  hostname: string | null
  offline_after_seconds: number
  maintenance: boolean
  notes: string | null
  created_at: string
  updated_at: string
}

/** Server Cloud avec, pour chaque hébergement, le nombre de sites (agrégat PostgREST). */
export interface CloudWithCounts extends CloudServer {
  web_hostings: { id: string; sites: { count: number }[] }[]
}

export interface WebHosting {
  id: string
  workspace_id: string
  cloud_server_id: string
  name: string
  technical_id: string | null
  system_metrics_collector: boolean
  access_log_path: string
  probe_url: string | null
  is_active: boolean
  /** Partie non secrète du token (affichage uniquement). */
  token_public_id: string | null
  token_active: boolean
  token_rotated_at: string | null
  created_at: string
  updated_at: string
}

export interface Site {
  id: string
  workspace_id: string
  web_hosting_id: string
  domain: string
  source: 'manual' | 'discovered' | 'log'
  is_verified: boolean
  is_active: boolean
  first_seen_at: string | null
  last_seen_at: string | null
  created_at: string
}

export interface ImportSitesResult {
  inserted: number
  existing: number
  invalid: string[]
}

/** Dernier relevé système d'un Server Cloud (calculé et stocké par agent_heartbeat). */
export interface MetricsPoint {
  ts: number
  cpu_cores: number
  load1: number
  load5: number
  load15: number
  load1_per_core: number
  cpu_pct: number | null
  mem_total_mb: number
  mem_used_mb: number
  mem_avail_mb: number
  mem_used_pct: number
  swap_total_mb: number
  swap_used_mb: number
  swap_used_pct: number
  disk_total_mb: number
  disk_used_mb: number
  disk_avail_mb: number
  disk_used_pct: number
  uptime_s: number
}

export interface CloudState {
  cloud_server_id: string
  last_metrics_at: string
  last_received_at: string
  last_point: MetricsPoint
}

export interface HostingState {
  web_hosting_id: string
  last_seen_at: string
  agent_version: string | null
  hostname_seen: string | null
  backlog: number | null
  last_error: string | null
  log_size_bytes: number | null
  log_inode: number | null
  anomaly: string | null
}

export type SeriesRange = '1h' | '6h' | '24h' | '7d' | '30d'

/** Un point de get_series() : moyenne ET pic de la tranche (sur 1 h / 6 h, moyenne = pic = valeur mesurée). */
export interface SeriesPoint {
  ts: string
  n: number
  load1_avg: number
  load1_max: number
  load5_avg: number
  load15_avg: number
  cpu_pct_avg: number | null
  cpu_pct_max: number | null
  mem_used_pct_avg: number
  mem_used_pct_max: number
  swap_used_pct_avg: number
  swap_used_pct_max: number
  disk_used_pct_avg: number
  disk_used_pct_max: number
}

export interface JobState {
  name: string
  last_run_at: string
  detail: Record<string, unknown>
}

export type Metric =
  | 'load1_per_core' | 'load5_per_core' | 'load1' | 'load5'
  | 'cpu_pct' | 'mem_used_pct' | 'swap_used_pct' | 'disk_used_pct'

export interface AlertRule {
  id: string
  workspace_id: string
  /** null = valeur par défaut du workspace ; sinon surcharge pour ce Server Cloud. */
  cloud_server_id: string | null
  metric: Metric
  warn_threshold: number
  crit_threshold: number
  window_minutes: number
  min_breach_ratio: number
  recover_margin: number
  recover_minutes: number
  enabled: boolean
}

export type CloudStatusValue = 'normal' | 'warning' | 'critical' | 'offline' | 'unknown' | 'maintenance'

export interface StatusReason {
  metric: Metric
  level: 'warning' | 'critical'
  value: number | null
  warn: number
  crit: number
  since: string
}

export interface CloudStatusRow {
  cloud_server_id: string
  status: CloudStatusValue
  status_since: string
  evaluated_at: string
  detail: {
    reasons: StatusReason[]
    connectivity: 'ok' | 'delayed' | 'silent' | 'never' | 'metrics_stale'
    offline_diagnosis: 'agents_silent' | 'unreachable_probable' | 'unknown_cause' | null
    last_agent_seen: string | null
    metrics_received: string | null
  }
}

export interface MetricPercentiles {
  metric: Metric
  n: number
  p50: number
  p95: number
  p99: number
  max: number
}

export interface ProbeResult {
  id: number
  web_hosting_id: string
  ts: string
  ok: boolean
  http_status: number | null
  latency_ms: number | null
  error: string | null
}

export type IncidentKind = 'performance' | 'disk' | 'offline' | 'agent'
export type IncidentStatus = 'warning' | 'critical' | 'recovery' | 'closed'

export interface Incident {
  id: string
  workspace_id: string
  cloud_server_id: string
  web_hosting_id: string | null
  kind: IncidentKind
  status: IncidentStatus
  severity_max: 'warning' | 'critical'
  started_at: string
  ended_at: string | null
  recovery_since: string | null
  reasons: Array<Partial<StatusReason> & { kind?: 'silent' | 'metrics_stale'; last_seen?: string }>
  peak: Partial<Record<Metric, number>>
  start_snapshot: Partial<MetricsPoint> | null
  diagnosis: 'agents_silent' | 'unreachable_probable' | 'unknown_cause' | null
  note: string | null
}

export interface IncidentWithNames extends Incident {
  cloud_servers: { name: string } | null
  web_hostings: { name: string } | null
}

export type IncidentEventType = 'opened' | 'escalated' | 'deescalated' | 'recovery_started' | 'relapse' | 'closed'

export interface IncidentEvent {
  id: number
  incident_id: string
  ts: string
  type: IncidentEventType
  data: { level?: 'warning' | 'critical'; from?: string; to?: string; duration_seconds?: number }
}
