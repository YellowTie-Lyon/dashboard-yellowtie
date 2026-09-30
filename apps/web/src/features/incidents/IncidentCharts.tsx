import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { mutedText } from '../../components/ui'
import { ErrorNote } from '../../components/ErrorNote'
import { bandFor, incidentEnd } from '../../lib/incidents'
import { buildRows, windowSpec } from '../../lib/series'
import type { Incident } from '../../lib/types'
import { LIVE } from '../../lib/live'
import { ChartGrid } from '../metrics/ChartGrid'
import { fetchSeriesWindow } from './api'

/** Courbes de la période d'un incident, avec une marge avant et après pour voir le début et le retour. */
export function IncidentCharts({ incident, cores, now }: { incident: Incident; cores: number | null; now: number }) {
  const start = new Date(incident.started_at).getTime()
  const end = incidentEnd(incident, now)
  const pad = Math.max(15 * 60_000, (end - start) * 0.25)
  // Les bornes sont arrondies à la minute : la requête (et sa clé de cache) ne change pas à chaque rendu.
  const from = Math.floor((start - pad) / 60_000) * 60_000
  const to = Math.floor((Math.min(now, end + pad)) / 60_000) * 60_000 + 60_000
  const spec = useMemo(() => windowSpec(from, to, now), [from, to, now])

  const series = useQuery({
    queryKey: ['incident-series', incident.cloud_server_id, from, to],
    queryFn: () => fetchSeriesWindow(incident.cloud_server_id, new Date(from).toISOString(), new Date(to).toISOString()),
    placeholderData: keepPreviousData,
    refetchInterval: incident.status === 'closed' ? false : LIVE.normal,
  })
  const rows = useMemo(() => buildRows(series.data ?? [], spec.stepMs), [series.data, spec.stepMs])

  if (series.error) return <ErrorNote error={series.error} />
  if (series.isPending) return <p className={mutedText}>Chargement des courbes…</p>
  if (rows.length === 0) {
    return (
      <p className={mutedText}>
        Aucun relevé détaillé pour cette période (les relevés d'une minute sont conservés 35 jours ; au-delà, seuls les agrégats horaires
        subsistent).
      </p>
    )
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartGrid rows={rows} spec={spec} from={from} to={to} cores={cores} bands={[bandFor(incident, now)]} />
    </div>
  )
}
