import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ErrorNote } from '../components/ErrorNote'
import { IncidentBadge } from '../components/IncidentBadge'
import { btnPrimary, card, input, mutedText } from '../components/ui'
import { fetchCloud } from '../features/inventory/api'
import { IncidentTraffic } from '../features/traffic/IncidentTraffic'
import { fetchIncident, fetchIncidentEvents, updateIncidentNote } from '../features/incidents/api'
import { useWorkspace } from '../features/workspace/useWorkspace'
import { formatMetric, metricMeta, reasonText } from '../lib/alerts'
import { formatRelativeTime } from '../lib/format'
import { DIAGNOSIS_LABELS } from '../lib/labels'
import { eventText, formatIncidentDuration, incidentEnd, KIND_LABELS } from '../lib/incidents'
import { LIVE } from '../lib/live'
import type { Metric, StatusReason } from '../lib/types'
import { useNow } from '../lib/useNow'

// Recharts est chargé à la demande, comme sur la page d'un Cloud.
const IncidentCharts = lazy(() => import('../features/incidents/IncidentCharts').then((m) => ({ default: m.IncidentCharts })))

const moment = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export function IncidentPage() {
  const { incidentId = '' } = useParams()
  const now = useNow(15_000)
  const { canWrite } = useWorkspace()
  const incident = useQuery({ queryKey: ['incident', incidentId], queryFn: () => fetchIncident(incidentId), refetchInterval: LIVE.fast })
  const events = useQuery({ queryKey: ['incident-events', incidentId], queryFn: () => fetchIncidentEvents(incidentId), refetchInterval: LIVE.fast })
  const cloud = useQuery({
    queryKey: ['cloud', incident.data?.cloud_server_id],
    queryFn: () => fetchCloud(incident.data!.cloud_server_id),
    enabled: Boolean(incident.data),
  })

  if (incident.isPending) return <p className={mutedText}>Chargement…</p>
  if (incident.error) return <ErrorNote error={incident.error} />
  if (!incident.data) {
    return (
      <div>
        <p className="font-medium">Incident introuvable.</p>
        <Link to="/incidents" className="text-sm underline">
          Retour aux incidents
        </Link>
      </div>
    )
  }

  const i = incident.data
  const peaks = Object.entries(i.peak) as [Metric, number][]
  const reasons = i.reasons.filter((r): r is StatusReason => Boolean(r.metric))

  return (
    <section className="space-y-6">
      <div>
        <Link to="/incidents" className="text-sm text-slate-500 hover:underline dark:text-slate-400">
          ← Incidents
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            {KIND_LABELS[i.kind]} ·{' '}
            <Link to={`/clouds/${i.cloud_server_id}`} className="uppercase hover:underline">
              {i.cloud_servers?.name ?? 'Server Cloud'}
            </Link>
            {i.web_hostings && i.web_hosting_id && (
              <>
                {' '}
                ·{' '}
                <Link to={`/hostings/${i.web_hosting_id}`} className="hover:underline">
                  {i.web_hostings.name}
                </Link>
              </>
            )}
          </h1>
          <IncidentBadge status={i.status} />
        </div>
      </div>

      <div className={card}>
        <h2 className="font-semibold">Résumé</h2>
        <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          {(
            [
              ['Début', `${moment(i.started_at)} (${formatRelativeTime(i.started_at, now)})`],
              ['Fin', i.status === 'closed' && i.ended_at ? moment(i.ended_at) : i.status === 'recovery' && i.recovery_since ? `retour constaté à ${moment(i.recovery_since)}` : 'en cours'],
              ['Durée', formatIncidentDuration(i, now)],
              ['Gravité maximale', i.severity_max === 'critical' ? 'Critical' : 'Warning'],
            ] as [string, string][]
          ).map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3 border-b border-slate-100 pb-1 dark:border-slate-800">
              <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
              <dd className="text-right font-medium">{value}</dd>
            </div>
          ))}
        </dl>

        {i.diagnosis && <p className="mt-3 text-sm">{DIAGNOSIS_LABELS[i.diagnosis]}</p>}
        {i.kind === 'agent' && i.reasons[0]?.kind === 'silent' && (
          <p className="mt-3 text-sm">Cet agent n'envoie plus de données alors que les autres agents du Cloud répondent : agent ou cron probablement arrêté.</p>
        )}
        {i.kind === 'agent' && i.reasons[0]?.kind === 'metrics_stale' && (
          <p className="mt-3 text-sm">Le collecteur système répond mais n'envoie plus de relevés : les valeurs système sont obsolètes.</p>
        )}

        {reasons.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-medium">{i.status === 'closed' ? 'Dernières raisons constatées' : 'Raisons actuelles'}</h3>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
              {reasons.map((r) => (
                <li key={r.metric}>{reasonText(r)}</li>
              ))}
            </ul>
          </div>
        )}

        {peaks.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-medium">Valeurs maximales pendant l'incident</h3>
            <ul className="mt-1 grid gap-x-8 gap-y-0.5 text-sm sm:grid-cols-2">
              {peaks.map(([metric, value]) => (
                <li key={metric} className="flex justify-between gap-3">
                  <span className="text-slate-500 dark:text-slate-400">{metricMeta(metric).label}</span>
                  <span className="font-medium">{formatMetric(metric, value)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className={`mt-4 text-xs ${mutedText}`}>Ces constats décrivent l'état observé ; ils n'établissent pas de cause.</p>
      </div>

      {(i.kind === 'performance' || i.kind === 'disk') && (
        <IncidentTraffic
          incidentId={i.id}
          open={i.status !== 'closed'}
          cloudName={i.cloud_servers?.name ?? 'Server Cloud'}
          incident={{
            cloud: i.cloud_servers?.name ?? 'Server Cloud',
            kind: i.kind,
            severity: i.severity_max,
            startedAt: new Date(i.started_at).toLocaleString('fr-FR'),
            endedAt: i.ended_at ? new Date(i.ended_at).toLocaleString('fr-FR') : null,
            peaks: peaks.map(([metric, value]) => `${metricMeta(metric).label} ${formatMetric(metric, value)}`),
          }}
        />
      )}

      <div className={card}>
        <h2 className="font-semibold">Chronologie</h2>
        <ErrorNote error={events.error} />
        <ol className="mt-3 space-y-2 border-l border-slate-200 pl-4 dark:border-slate-700">
          {(events.data ?? []).map((e) => (
            <li key={e.id} className="relative text-sm">
              <span aria-hidden className="absolute -left-[21px] top-1.5 size-2.5 rounded-full bg-slate-400" />
              <span className="font-medium">{eventText(e)}</span>
              <span className="ml-2 text-slate-500 dark:text-slate-400">{moment(e.ts)}</span>
            </li>
          ))}
        </ol>
      </div>

      <NoteEditor key={`${i.id}-${i.note ?? ''}`} incidentId={i.id} initial={i.note ?? ''} canWrite={canWrite} />

      {['performance', 'disk'].includes(i.kind) || i.kind === 'offline' ? (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Courbes de la période</h2>
          <p className={mutedText}>
            La zone colorée marque l'incident ; les repères ajoutent une marge avant et après pour voir le début et le retour.
            {incidentEnd(i, now) < now - 34 * 86_400_000 ? ' Période ancienne : agrégats horaires.' : ''}
          </p>
          <Suspense fallback={<p className={mutedText}>Chargement des courbes…</p>}>
            <IncidentCharts incident={i} cores={cloud.data?.cpu_cores ?? null} now={now} />
          </Suspense>
        </div>
      ) : null}
    </section>
  )
}

function NoteEditor({ incidentId, initial, canWrite }: { incidentId: string; initial: string; canWrite: boolean }) {
  const queryClient = useQueryClient()
  const [text, setText] = useState(initial)
  const save = useMutation({
    mutationFn: () => updateIncidentNote(incidentId, text),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['incident', incidentId] }),
  })
  function onSubmit(e: FormEvent) {
    e.preventDefault()
    save.mutate()
  }
  return (
    <form onSubmit={onSubmit} className={card}>
      <h2 className="font-semibold">Note</h2>
      <p className={mutedText}>Gardez ici l'explication (cause identifiée, action menée) à côté de la trace de l'incident.</p>
      <textarea
        rows={3}
        maxLength={2000}
        value={text}
        disabled={!canWrite}
        placeholder={canWrite ? 'Ex. : plugin de cache désactivé, retour à la normale confirmé.' : 'Aucune note.'}
        onChange={(e) => setText(e.target.value)}
        className={`${input} mt-2`}
      />
      <ErrorNote error={save.error} />
      {canWrite && (
        <div className="mt-2 flex justify-end">
          <button type="submit" className={btnPrimary} disabled={save.isPending || text === initial}>
            {save.isPending ? 'Enregistrement…' : 'Enregistrer la note'}
          </button>
        </div>
      )}
    </form>
  )
}
