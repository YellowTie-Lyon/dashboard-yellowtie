import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { card, input, mutedText } from '../components/ui'
import { AlertRulesEditor } from '../features/alerts/AlertRulesEditor'
import { fetchClouds } from '../features/inventory/api'
import { fetchJobStates } from '../features/metrics/api'
import { formatRelativeTime } from '../lib/format'
import { LIVE } from '../lib/live'
import { useNow } from '../lib/useNow'

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
              Mesures de référence
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
      </div>

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
            <strong>Notifications</strong> : aucune notification externe n'est configurée. Les statuts s'affichent dans
            YellowScope, mis à jour automatiquement.
          </li>
        </ul>
      </div>
    </section>
  )
}
