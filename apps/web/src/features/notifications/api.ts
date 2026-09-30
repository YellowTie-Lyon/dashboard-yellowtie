import { getSupabase } from '../../lib/supabase'

export interface NotificationSettings {
  workspace_id: string
  enabled: boolean
  min_level: 'warning' | 'critical'
  notify_recovery: boolean
  reminder_minutes: number
  mention: string | null
  mention_warning: boolean
  site_url: string | null
  has_webhook: boolean
  /** 4 derniers caractères de l'adresse du webhook : la seule trace lisible côté client (l'adresse est un secret). */
  webhook_hint: string | null
  updated_at: string
}

export interface NotificationLog {
  id: number
  kind: 'alert' | 'recovery' | 'reminder' | 'test'
  summary: string
  status: 'pending' | 'sending' | 'sent' | 'failed'
  attempts: number
  last_error: string | null
  created_at: string
  sent_at: string | null
}

// Colonnes listées une à une : la colonne secrète (adresse du webhook) est refusée par la base à tout client.
const SETTINGS_COLUMNS =
  'workspace_id, enabled, min_level, notify_recovery, reminder_minutes, mention, mention_warning, site_url, has_webhook, webhook_hint, updated_at'

export async function fetchNotificationSettings(): Promise<NotificationSettings | null> {
  const { data, error } = await getSupabase().from('notification_settings').select(SETTINGS_COLUMNS).maybeSingle()
  if (error) throw error
  return (data ?? null) as NotificationSettings | null
}

export async function fetchNotificationLog(): Promise<NotificationLog[]> {
  const { data, error } = await getSupabase()
    .from('notification_outbox')
    .select('id, kind, summary, status, attempts, last_error, created_at, sent_at')
    .order('id', { ascending: false })
    .limit(8)
  if (error) throw error
  return (data ?? []) as NotificationLog[]
}

export interface SaveInput {
  /** null = conserver l'adresse actuelle ; '' = la supprimer. */
  webhookUrl: string | null
  enabled: boolean
  minLevel: 'warning' | 'critical'
  notifyRecovery: boolean
  reminderMinutes: number
  /** null = conserver ; '' = aucune mention. */
  mention: string | null
  mentionWarning: boolean
}

export async function saveNotificationSettings(input: SaveInput): Promise<void> {
  const { error } = await getSupabase().rpc('save_notification_settings', {
    _webhook_url: input.webhookUrl,
    _enabled: input.enabled,
    _min_level: input.minLevel,
    _notify_recovery: input.notifyRecovery,
    _reminder_minutes: input.reminderMinutes,
    _mention: input.mention,
    _mention_warning: input.mentionWarning,
    _site_url: window.location.origin,
  })
  if (error) throw error
}

export type TestType = 'basic' | 'critical' | 'warning' | 'reminder' | 'recovery' | 'offline' | 'agent' | 'live'

export async function sendTestNotification(type: TestType = 'basic'): Promise<void> {
  const { error } = await getSupabase().rpc('send_test_notification', { _type: type })
  if (error) throw error
}
