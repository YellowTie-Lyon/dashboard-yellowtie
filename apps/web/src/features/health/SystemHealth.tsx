import { useQuery } from '@tanstack/react-query'
import { ErrorNote } from '../../components/ErrorNote'
import { card, labelMono, mutedText } from '../../components/ui'
import { formatRelativeTime } from '../../lib/format'
import { DB_QUOTA_BYTES, formatSize, JOBS, jobHealth, storageLevel } from '../../lib/health'
import { useNow } from '../../lib/useNow'
import { fetchJobStates } from '../metrics/api'
import { fetchStorageStats } from './api'

const LEVEL_TEXT = { ok: 'text-green-400', late: 'text-red-400', never: 'text-slate-400' } as const
const LEVEL_LABEL = { ok: 'En marche', late: 'En retard', never: 'Pas encore exécutée' } as const

/** Deux contrôles d'exploitation : les tâches planifiées tournent-elles ? la base reste-t-elle sous le quota Supabase ? */
export function SystemHealth() {
  const now = useNow(30_000)
  const jobs = useQuery({ queryKey: ['job-states'], queryFn: fetchJobStates })
  const storage = useQuery({ queryKey: ['storage-stats'], queryFn: fetchStorageStats })
  const used = storage.data?.db_bytes ?? 0
  const level = storageLevel(used)
  const pct = Math.min(100, (100 * used) / DB_QUOTA_BYTES)
  const barColor = level === 'critical' ? 'bg-red-500' : level === 'warning' ? 'bg-orange-500' : 'bg-brand'

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className={card}>
        <h2 className="font-semibold">Tâches planifiées</h2>
        <p className={mutedText}>Elles tournent dans Supabase (pg_cron) : évaluation, agrégations et purges.</p>
        <ErrorNote error={jobs.error} />
        <ul className="mt-3 divide-y divide-white/10">
          {JOBS.map((spec) => {
            const h = jobHealth(spec, jobs.data ?? [], now)
            return (
              <li key={spec.name} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                <span>{spec.label}</span>
                <span className="text-right">
                  <span className={`font-medium ${h.problem ? 'text-red-400' : LEVEL_TEXT[h.level]}`}>{LEVEL_LABEL[h.level]}</span>
                  {h.lastRunAt && <span className="ml-2 text-xs text-slate-500">{formatRelativeTime(h.lastRunAt, now)}</span>}
                </span>
              </li>
            )
          })}
        </ul>
        <p className={`mt-3 text-xs ${mutedText}`}>
          Une tâche en retard : ouvrez Supabase &gt; Database &gt; Extensions et vérifiez que <strong>pg_cron</strong> est activée (voir le mode d'emploi).
        </p>
      </div>

      <div className={card}>
        <h2 className="font-semibold">Stockage de la base</h2>
        <p className={mutedText}>Quota de l'offre Supabase Free : {formatSize(DB_QUOTA_BYTES)}.</p>
        <ErrorNote error={storage.error} />
        {storage.data && (
          <>
            <div className="mt-3 flex items-baseline justify-between">
              <span className={`text-3xl font-bold tabular-nums ${level === 'critical' ? 'text-red-400' : level === 'warning' ? 'text-orange-400' : ''}`}>{formatSize(used)}</span>
              <span className="text-sm text-slate-400">{Math.round(pct)} % du quota</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label="Stockage utilisé" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
              <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
            </div>
            {level !== 'ok' && (
              <p className={`mt-2 text-sm font-medium ${level === 'critical' ? 'text-red-400' : 'text-orange-400'}`}>
                {level === 'critical'
                  ? 'Quota presque atteint : réduisez les durées de conservation ou passez à une offre supérieure.'
                  : 'Plus de 70 % du quota : surveillez la croissance.'}
              </p>
            )}
            <h3 className={`mt-4 ${labelMono}`}>Plus grosses tables</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {storage.data.tables.slice(0, 6).map((t) => (
                <li key={t.name} className="flex justify-between gap-3">
                  <span className="font-mono">{t.name}</span>
                  <span className="tabular-nums text-slate-300">
                    {formatSize(t.bytes)}
                    <span className="ml-2 text-xs text-slate-500">≈ {t.rows.toLocaleString('fr-FR')} lignes</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
