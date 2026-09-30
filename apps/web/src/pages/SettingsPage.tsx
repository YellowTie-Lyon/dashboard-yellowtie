import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorNote } from '../components/ErrorNote'
import { btnPrimary } from '../components/ui'
import { fetchCloseMinutes, updateCloseMinutes } from '../features/incidents/api'
import { useWorkspace } from '../features/workspace/useWorkspace'
import { card, input, mutedText } from '../components/ui'
import { AlertRulesEditor } from '../features/alerts/AlertRulesEditor'
import { fetchClouds } from '../features/inventory/api'
import { fetchJobStates } from '../features/metrics/api'
import { formatRelativeTime } from '../lib/format'
import { LIVE } from '../lib/live'
import { useNow } from '../lib/useNow'
import { SystemHealth } from '../features/health/SystemHealth'
import { NotificationsCard } from '../features/notifications/NotificationsCard'

export function SettingsPage() {
  const clouds = useQuery({ queryKey: ['clouds'], queryFn: fetchClouds, refetchInterval: LIVE.slow })
  const jobs = useQuery({ queryKey: ['job-states'], queryFn: fetchJobStates, refetchInterval: LIVE.slow })
  const [selected, setSelected] = useState<string>('')
  const now = useNow(30_000)
  const calibrationId = selected || clouds.data?.[0]?.id || null
  const probes = jobs.data?.find((j) => j.name === 'probes')
  const probeError = typeof probes?.detail?.error === 'string' ? probes.detail.error : null

  return (
    <section className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Réglages</h1>
        <p className={mutedText}>Seuils d'alerte, hystérésis et sondes.</p>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Seuils d'alerte par défaut</h2>
            <p className={`max-w-3xl ${mutedText}`}>
              S'appliquent à tous les Server Clouds, sauf personnalisation sur la page d'un Cloud. Les valeurs de départ
              sont <strong>provisoires</strong> : comparez-les aux mesures réelles affichées sous chaque règle (médiane, p95,
              p99, max sur 7 jours) avant de les figer. Les statuts se recalculent dès l'enregistrement.
            </p>
          </div>
          {(clouds.data?.length ?? 0) > 0 && (
            <label className="text-sm font-medium">
              Mesures de référence (affichage seulement)
              <select value={calibrationId ?? ''} onChange={(e) => setSelected(e.target.value)} className={`${input} mt-1 w-auto`}>
                {clouds.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <AlertRulesEditor cloudId={null} calibrationCloudId={calibrationId} />
        {(clouds.data?.length ?? 0) > 0 && (
          <div className={card}>
            <h3 className="font-semibold">Seuils différents pour un Server Cloud</h3>
            <p className={`mt-1 ${mutedText}`}>
              Le menu « Mesures de référence » ne change que les statistiques affichées, pas les seuils. Pour donner à un Cloud ses propres
              seuils, ouvrez sa page puis « Seuils d'alerte de ce Server Cloud ».
            </p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {clouds.data?.map((c) => (
                <li key={c.id}>
                  <Link to={`/clouds/${c.id}`} className="inline-flex rounded-full border border-white/15 px-3 py-1 text-sm font-medium hover:bg-white/10">
                    {c.name} →
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <NotificationsCard />

      <CloseDelayCard />

      <SystemHealth />

      <div className={card}>
        <h2 className="font-semibold">Sondes et notifications</h2>
        <ul className={`mt-2 list-disc space-y-1 pl-5 ${mutedText}`}>
          <li>
            <strong>Sondes HTTP</strong> : renseignez l'URL de sonde (HTTPS) sur la page de chaque hébergement. Toutes les
            5 minutes, et chaque minute quand son agent est en retard, elle permet de distinguer « agent arrêté » de « Cloud
            potentiellement inaccessible ».{' '}
            {probes
              ? `Dernier passage ${formatRelativeTime(probes.last_run_at, now)}.`
              : 'Aucun passage enregistré pour le moment.'}
          </li>
          {probeError && (
            <li className="text-amber-700 dark:text-amber-400">
              Les sondes ne peuvent pas s'exécuter : {probeError} (l'extension pg_net doit être activée dans Supabase &gt;
              Database &gt; Extensions).
            </li>
          )}
          <li>
            <strong>Notifications</strong> : voir la carte « Notifications Slack » ci-dessus. Les statuts s'affichent aussi dans
            YellowScope, mis à jour automatiquement.
          </li>
        </ul>
      </div>
    </section>
  )
}

function CloseDelayCard() {
  const queryClient = useQueryClient()
  const { workspace, canWrite } = useWorkspace()
  const current = useQuery({ queryKey: ['settings', 'incident_close_minutes'], queryFn: fetchCloseMinutes })
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? String(current.data ?? 5)
  const minutes = Number(value)
  const valid = Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440
  const save = useMutation({
    mutationFn: () => updateCloseMinutes(workspace!.id, minutes),
    onSuccess: async () => {
      setDraft(null)
      await queryClient.invalidateQueries({ queryKey: ['settings', 'incident_close_minutes'] })
    },
  })
  return (
    <div className={card}>
      <h2 className="font-semibold">Clôture des incidents</h2>
      <p className={`max-w-3xl ${mutedText}`}>
        Un incident passe en « retour à la normale » dès que les valeurs repassent sous les seuils. Il est clos après ce délai de
        stabilité ; s'il rechute avant, c'est le même incident qui reprend.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-sm font-medium">
          Délai de stabilité (minutes)
          <input
            type="number"
            min={1}
            max={1440}
            value={value}
            disabled={!canWrite}
            onChange={(e) => setDraft(e.target.value)}
            className={`${input} mt-1 w-32`}
          />
        </label>
        {canWrite && (
          <button type="button" className={btnPrimary} disabled={!valid || draft === null || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        )}
      </div>
      <ErrorNote error={current.error ?? save.error} />
    </div>
  )
}
