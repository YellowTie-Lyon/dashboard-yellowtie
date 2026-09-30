import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationLog, NotificationSettings, SaveInput } from './api'
import { NotificationsCard } from './NotificationsCard'

const fetchSettings = vi.fn<() => Promise<NotificationSettings | null>>()
const fetchLog = vi.fn<() => Promise<NotificationLog[]>>()
const save = vi.fn<(i: SaveInput) => Promise<void>>()
const test = vi.fn<(type: string) => Promise<void>>()
let canWrite = true

vi.mock('./api', () => ({
  fetchNotificationSettings: () => fetchSettings(),
  fetchNotificationLog: () => fetchLog(),
  saveNotificationSettings: (i: SaveInput) => save(i),
  sendTestNotification: (t: string) => test(t),
}))
vi.mock('../workspace/useWorkspace', () => ({ useWorkspace: () => ({ workspace: { id: 'w', name: 'W', role: 'owner' }, isPending: false, error: null, canWrite }) }))

const settings = (o: Partial<NotificationSettings> = {}): NotificationSettings => ({
  workspace_id: 'w', enabled: true, min_level: 'critical', notify_recovery: true, reminder_minutes: 30, mention: null, mention_warning: false, site_url: 'https://x.fr',
  has_webhook: true, webhook_hint: 'AbCd', updated_at: '2026-09-30T10:00:00Z', ...o,
})

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <NotificationsCard />
    </QueryClientProvider>,
  )
}

describe('NotificationsCard', () => {
  beforeEach(() => {
    canWrite = true
    for (const f of [fetchSettings, fetchLog, save, test]) f.mockReset()
    fetchLog.mockResolvedValue([])
    save.mockResolvedValue(undefined)
    test.mockResolvedValue(undefined)
  })

  it('première configuration : enregistre l’adresse du webhook et active les notifications', async () => {
    fetchSettings.mockResolvedValue(null)
    renderIt()
    await screen.findByText('Désactivées')
    expect(screen.getByRole('button', { name: 'Test simple' })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Adresse du webhook Slack'), 'https://hooks.slack.com/services/T000/B000/XXXXXXXX')
    await userEvent.click(screen.getByLabelText(/Activer les notifications Slack/))
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(save).toHaveBeenCalledWith({ webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXXXXXX', enabled: true, minLevel: 'critical', notifyRecovery: true, reminderMinutes: 30, mention: '', mentionWarning: false })
    expect(await screen.findByText('Réglages enregistrés.')).toBeInTheDocument()
  })

  it('n’affiche jamais l’adresse enregistrée, seulement ses 4 derniers caractères, et la conserve si le champ reste vide', async () => {
    fetchSettings.mockResolvedValue(settings())
    renderIt()
    expect(await screen.findByText('Activées')).toBeInTheDocument()
    const field = screen.getByLabelText('Adresse du webhook Slack')
    expect(field).toHaveValue('')
    expect(field).toHaveAttribute('placeholder', expect.stringContaining('…AbCd'))
    await userEvent.selectOptions(screen.getByLabelText('Niveau minimum pour alerter'), 'warning')
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(save).toHaveBeenCalledWith({ webhookUrl: null, enabled: true, minLevel: 'warning', notifyRecovery: true, reminderMinutes: 30, mention: '', mentionWarning: false })
  })

  it('envoie un message de test et supprime l’adresse à la demande', async () => {
    fetchSettings.mockResolvedValue(settings())
    renderIt()
    await screen.findByText('Activées')
    await userEvent.click(screen.getByRole('button', { name: 'Test simple' }))
    await userEvent.click(screen.getByRole('button', { name: 'Alerte Critical' }))
    await userEvent.click(screen.getByRole('button', { name: 'Retour à la normale' }))
    expect(test.mock.calls.map((c) => c[0])).toEqual(['basic', 'critical', 'recovery'])
    await userEvent.click(screen.getByRole('button', { name: "Supprimer l'adresse" }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ webhookUrl: '' }))
  })

  it('explique une adresse refusée par la base', async () => {
    fetchSettings.mockResolvedValue(null)
    save.mockRejectedValue({ code: '23514', message: 'check' })
    renderIt()
    await screen.findByText('Désactivées')
    await userEvent.type(screen.getByLabelText('Adresse du webhook Slack'), 'https://evil.example/x')
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('https://hooks.slack.com/services/')
  })

  it('affiche l’historique des derniers envois, avec la cause d’un échec', async () => {
    fetchSettings.mockResolvedValue(settings())
    fetchLog.mockResolvedValue([
      { id: 2, kind: 'alert', summary: '🔴 Critical · Cloud 1 (Performance)', status: 'failed', attempts: 3, last_error: 'HTTP 404', created_at: new Date().toISOString(), sent_at: null },
      { id: 1, kind: 'test', summary: 'Test de notification', status: 'sent', attempts: 1, last_error: null, created_at: new Date().toISOString(), sent_at: new Date().toISOString() },
    ])
    renderIt()
    expect(await screen.findByText('Échec')).toBeInTheDocument()
    expect(screen.getByText('HTTP 404')).toBeInTheDocument()
    expect(screen.getByText('Envoyé')).toBeInTheDocument()
  })

  it('un lecteur consulte l’état sans pouvoir le modifier', async () => {
    canWrite = false
    fetchSettings.mockResolvedValue(settings())
    renderIt()
    await screen.findByText('Activées')
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Adresse du webhook Slack')).toBeDisabled()
    expect(screen.getByText(/Seuls les propriétaires/)).toBeInTheDocument()
  })

  it('propose un exemple de chaque notification', async () => {
    fetchSettings.mockResolvedValue(settings())
    renderIt()
    await screen.findByText('Activées')
    for (const name of ['État réel actuel', 'Test simple', 'Alerte Critical', 'Alerte Warning', 'Rappel', 'Retour à la normale', 'Cloud hors ligne', 'Agent silencieux']) {
      expect(screen.getByRole('button', { name })).toBeEnabled()
    }
  })

  it('enregistre une mention @here et l’option Warning', async () => {
    fetchSettings.mockResolvedValue(settings())
    renderIt()
    await screen.findByText('Activées')
    await userEvent.selectOptions(screen.getByLabelText(/Qui mentionner/), 'here')
    await userEvent.click(screen.getByLabelText(/Mentionner aussi pour les Warning/))
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ mention: '<!here>', mentionWarning: true }))
  })

  it('convertit des identifiants Slack saisis en mentions et refuse une saisie invalide', async () => {
    fetchSettings.mockResolvedValue(settings())
    renderIt()
    await screen.findByText('Activées')
    await userEvent.selectOptions(screen.getByLabelText(/Qui mentionner/), 'custom')
    await userEvent.type(screen.getByLabelText(/Identifiants Slack/), 'julien')
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Mention invalide')
    expect(save).not.toHaveBeenCalled()
    await userEvent.clear(screen.getByLabelText(/Identifiants Slack/))
    await userEvent.type(screen.getByLabelText(/Identifiants Slack/), 'U012ABCDEF')
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ mention: '<@U012ABCDEF>' }))
  })
})
