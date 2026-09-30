import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ErrorNote } from '../../components/ErrorNote'
import { btn, btnDanger, btnPrimary, card, input, labelMono, mutedText } from '../../components/ui'
import { formatRelativeTime } from '../../lib/format'
import { mentionChoice, mentionForInput, parseMentions, type MentionChoice } from '../../lib/slack'
import { useNow } from '../../lib/useNow'
import { useWorkspace } from '../workspace/useWorkspace'
import { fetchNotificationLog, fetchNotificationSettings, saveNotificationSettings, sendTestNotification, type NotificationLog, type NotificationSettings, type TestType } from './api'

const STATUS: Record<NotificationLog['status'], { label: string; cls: string }> = {
  pending: { label: 'En attente', cls: 'text-slate-300' },
  sending: { label: 'Envoi…', cls: 'text-slate-300' },
  sent: { label: 'Envoyé', cls: 'text-green-400' },
  failed: { label: 'Échec', cls: 'text-red-400' },
}
const TESTS: { type: TestType; label: string; hint: string }[] = [
  { type: 'live', label: 'État réel actuel', hint: 'Vos vrais Clouds, avec les vraies valeurs du moment (données réelles)' },
  { type: 'basic', label: 'Test simple', hint: 'Vérifie que le canal reçoit les messages' },
  { type: 'critical', label: 'Alerte Critical', hint: 'Cloud en Critical (rouge, avec mention)' },
  { type: 'warning', label: 'Alerte Warning', hint: 'Cloud en Warning (orange)' },
  { type: 'reminder', label: 'Rappel', hint: 'Incident toujours Critical' },
  { type: 'recovery', label: 'Retour à la normale', hint: 'Incident clos (vert)' },
  { type: 'offline', label: 'Cloud hors ligne', hint: 'Plus aucun agent ne répond' },
  { type: 'agent', label: 'Agent silencieux', hint: 'Un agent ne répond plus' },
]
const KIND: Record<NotificationLog['kind'], string> = { alert: 'Alerte', recovery: 'Retour à la normale', reminder: 'Rappel', test: 'Test' }

function friendly(error: unknown): unknown {
  const e = error as { code?: string; message?: string } | null
  if (e?.code === '23514') return new Error('Adresse invalide : elle doit commencer par https://hooks.slack.com/services/…')
  if (e?.code === '22023') return new Error("Enregistrez d'abord l'adresse du webhook Slack.")
  if (e?.code === '42501') return new Error('Réservé aux propriétaires (double authentification validée).')
  return error
}

/** Alertes Slack : adresse du webhook (secret, jamais réaffichée), règles d'envoi, message de test et historique des derniers envois. */
export function NotificationsCard() {
  const settings = useQuery({ queryKey: ['notification-settings'], queryFn: fetchNotificationSettings })
  const log = useQuery({ queryKey: ['notification-log'], queryFn: fetchNotificationLog })
  return <NotificationsForm key={settings.data?.updated_at ?? 'none'} settings={settings.data ?? null} loading={settings.isPending} loadError={settings.error} log={log.data ?? []} />
}

function NotificationsForm({ settings, loading, loadError, log }: { settings: NotificationSettings | null; loading: boolean; loadError: unknown; log: NotificationLog[] }) {
  const queryClient = useQueryClient()
  const { canWrite } = useWorkspace()
  const now = useNow(30_000)
  const [webhook, setWebhook] = useState('')
  const [enabled, setEnabled] = useState(settings?.enabled ?? false)
  const [minLevel, setMinLevel] = useState<'warning' | 'critical'>(settings?.min_level ?? 'critical')
  const [notifyRecovery, setNotifyRecovery] = useState(settings?.notify_recovery ?? true)
  const [reminder, setReminder] = useState(settings?.reminder_minutes ?? 30)
  const [choice, setChoice] = useState<MentionChoice>(mentionChoice(settings?.mention))
  const [custom, setCustom] = useState(mentionChoice(settings?.mention) === 'custom' ? mentionForInput(settings?.mention) : '')
  const [mentionWarning, setMentionWarning] = useState(settings?.mention_warning ?? false)
  const [localError, setLocalError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['notification-settings'] })
    await queryClient.invalidateQueries({ queryKey: ['notification-log'] })
  }
  const hasWebhook = Boolean(settings?.has_webhook)

  const save = useMutation({
    mutationFn: (v: { webhookUrl: string | null; mention: string | null }) =>
      saveNotificationSettings({ webhookUrl: v.webhookUrl, enabled, minLevel, notifyRecovery, reminderMinutes: reminder, mention: v.mention, mentionWarning }),
    onSuccess: async (_d, v) => {
      setNotice(v.webhookUrl === '' ? 'Adresse du webhook supprimée : les notifications sont désactivées.' : 'Réglages enregistrés.')
      setWebhook('')
      await refresh()
    },
  })
  const test = useMutation({
    mutationFn: (type: TestType) => sendTestNotification(type),
    onSuccess: async () => {
      setNotice('Message de test envoyé : il doit apparaître dans votre canal Slack dans quelques secondes.')
      await refresh()
      window.setTimeout(() => void refresh(), 4000)
    },
  })

  function mentionValue(): string | null {
    if (choice === 'none') return ''
    if (choice === 'here') return '<!here>'
    if (choice === 'channel') return '<!channel>'
    return parseMentions(custom)
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setNotice(null)
    setLocalError(null)
    const mention = mentionValue()
    if (mention === null) {
      return setLocalError(new Error("Mention invalide : saisissez l'identifiant Slack d'un membre (commence par U) ou d'un groupe (commence par S), 3 au plus."))
    }
    save.mutate({ webhookUrl: webhook.trim() ? webhook.trim() : null, mention })
  }
  const disabled = !canWrite || save.isPending

  return (
    <div className={card}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className={labelMono}>Alertes · Slack</p>
          <h2 className="text-lg font-semibold">Notifications Slack</h2>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${settings?.enabled && hasWebhook ? 'bg-green-500/10 text-green-300' : 'bg-white/10 text-slate-300'}`}>
          {settings?.enabled && hasWebhook ? 'Activées' : 'Désactivées'}
        </span>
      </div>
      <p className={`mt-1 max-w-3xl ${mutedText}`}>
        Un message dans votre canal Slack quand un incident s'ouvre ou s'aggrave, avec le motif, les domaines les plus sollicités (« potentiellement
        impliqués ») et un lien vers l'incident, puis un message quand tout est revenu à la normale.
      </p>
      <ErrorNote error={loadError} />
      {loading && <p className={`mt-2 ${mutedText}`}>Chargement…</p>}

      <details className="mt-3 rounded-xl border border-white/10 px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium">Comment obtenir l'adresse du webhook Slack ?</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-300">
          <li>Ouvrez <span className="font-mono">api.slack.com/apps</span> et cliquez sur <strong>Create New App</strong> puis <strong>From scratch</strong> (nom : YellowScope, choisissez votre espace Slack).</li>
          <li>Menu <strong>Incoming Webhooks</strong> : activez l'option.</li>
          <li><strong>Add New Webhook to Workspace</strong> : choisissez le canal qui recevra les alertes, puis <strong>Autoriser</strong>.</li>
          <li>Copiez l'adresse qui commence par <span className="font-mono">https://hooks.slack.com/services/…</span> et collez-la ci-dessous. Elle est secrète : n'importe qui la possédant peut écrire dans votre canal.</li>
        </ol>
      </details>

      <form onSubmit={onSubmit} className="mt-4 space-y-4">
        <label className="block text-sm font-medium">
          Adresse du webhook Slack
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
            placeholder={hasWebhook ? `Configurée (…${settings?.webhook_hint}) : laissez vide pour la conserver` : 'https://hooks.slack.com/services/…'}
            className={`${input} font-mono`}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium">
            Niveau minimum pour alerter
            <select value={minLevel} disabled={disabled} onChange={(e) => setMinLevel(e.target.value as 'warning' | 'critical')} className={input}>
              <option value="critical">Critical seulement (recommandé)</option>
              <option value="warning">Warning et Critical</option>
            </select>
          </label>
          <label className="text-sm font-medium">
            Rappel tant que l'incident reste Critical
            <select value={reminder} disabled={disabled} onChange={(e) => setReminder(Number(e.target.value))} className={input}>
              <option value={0}>Jamais</option>
              <option value={15}>Toutes les 15 minutes</option>
              <option value={30}>Toutes les 30 minutes</option>
              <option value={60}>Toutes les heures</option>
              <option value={120}>Toutes les 2 heures</option>
            </select>
          </label>
        </div>

        <div className="rounded-xl border border-white/10 p-4">
          <label className="block text-sm font-medium">
            Qui mentionner (« pinguer ») dans l'alerte ?
            <select value={choice} disabled={disabled} onChange={(e) => setChoice(e.target.value as MentionChoice)} className={input}>
              <option value="none">Personne</option>
              <option value="here">@here : les membres du salon connectés</option>
              <option value="channel">@channel : tous les membres du salon</option>
              <option value="custom">Une ou plusieurs personnes / un groupe</option>
            </select>
          </label>
          {choice === 'custom' && (
            <label className="mt-3 block text-sm font-medium">
              Identifiants Slack
              <input
                type="text"
                spellCheck={false}
                disabled={disabled}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="U012ABCDEF  S0123ABCDE"
                className={`${input} font-mono`}
              />
              <span className="mt-1 block text-xs font-normal text-slate-500">
                Membre : dans Slack, ouvrez son profil, menu ⋮, <strong>Copier l'ID du membre</strong> (commence par U). Groupe d'utilisateurs : son identifiant commence par S.
                Séparez par un espace, 3 au plus.
              </span>
            </label>
          )}
          {choice !== 'none' && (
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={mentionWarning} disabled={disabled} onChange={(e) => setMentionWarning(e.target.checked)} />
              Mentionner aussi pour les Warning (par défaut : seulement Critical et rappels)
            </label>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={notifyRecovery} disabled={disabled} onChange={(e) => setNotifyRecovery(e.target.checked)} />
          Prévenir aussi du retour à la normale
        </label>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={enabled} disabled={disabled || (!hasWebhook && !webhook.trim())} onChange={(e) => setEnabled(e.target.checked)} />
          Activer les notifications Slack
        </label>

        <ErrorNote error={localError ?? friendly(save.error ?? test.error)} />
        {notice && <p role="status" className="text-sm text-green-300">{notice}</p>}

        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={btnPrimary} disabled={save.isPending}>
              {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
            </button>
            {hasWebhook && (
              <button type="button" className={btnDanger} disabled={save.isPending} onClick={() => { setNotice(null); save.mutate({ webhookUrl: '', mention: null }) }}>
                Supprimer l'adresse
              </button>
            )}
          </div>
        ) : (
          <p className={mutedText}>Seuls les propriétaires peuvent modifier ces réglages.</p>
        )}
      </form>

      {canWrite && (
        <div className="mt-5">
          <h3 className={labelMono}>Envoyer un exemple de chaque notification</h3>
          <p className={`mt-1 text-xs ${mutedText}`}>
            « État réel actuel » utilise vos vrais Clouds et leurs vraies valeurs. Les autres exemples sont marqués [TEST] avec des données fictives, mais identiques aux vraies alertes (couleurs, mention, bouton) ; les vraies alertes, elles, utilisent toujours les données réelles de l'incident. Enregistrez d'abord vos réglages.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {TESTS.map((t) => (
              <button key={t.type} type="button" className={btn} title={t.hint} disabled={!hasWebhook || test.isPending} onClick={() => { setNotice(null); test.mutate(t.type) }}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {log.length > 0 && (
        <div className="mt-5">
          <h3 className={labelMono}>Derniers envois</h3>
          <ul className="mt-2 divide-y divide-white/10 text-sm">
            {log.map((l) => (
              <li key={l.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2">
                <span className="min-w-0 flex-1 basis-64 truncate" title={l.summary}>
                  <span className="mr-2 rounded-full border border-white/15 px-2 py-0.5 text-xs text-slate-300">{KIND[l.kind]}</span>
                  {l.summary}
                </span>
                <span className="text-right text-xs">
                  <span className={`font-medium ${STATUS[l.status].cls}`}>{STATUS[l.status].label}</span>
                  <span className="ml-2 text-slate-500">{formatRelativeTime(l.created_at, now)}</span>
                  {l.status !== 'sent' && l.last_error && <span className="ml-2 text-red-400">{l.last_error}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
