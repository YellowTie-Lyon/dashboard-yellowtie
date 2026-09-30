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
  source: 'manual' | 'discovered'
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
