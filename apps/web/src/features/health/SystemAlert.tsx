import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { JOBS, jobHealth, storageLevel } from '../../lib/health'
import { useNow } from '../../lib/useNow'
import { fetchJobStates } from '../metrics/api'
import { fetchStorageStats } from './api'

/** Pastille discrète dans l'en-tête : n'apparaît que si une tâche planifiée est en retard ou si la base approche du quota. */
export function SystemAlert() {
  const now = useNow(30_000)
  const jobs = useQuery({ queryKey: ['job-states'], queryFn: fetchJobStates })
  const storage = useQuery({ queryKey: ['storage-stats'], queryFn: fetchStorageStats })
  const problems: string[] = []
  if (jobs.isSuccess) for (const spec of JOBS) if (jobHealth(spec, jobs.data, now).problem) problems.push(spec.label)
  if (storage.data && storageLevel(storage.data.db_bytes) !== 'ok') problems.push('Stockage de la base')
  if (problems.length === 0) return null
  return (
    <Link
      to="/reglages"
      title={problems.join(' · ')}
      className="flex items-center gap-1.5 rounded-full border border-orange-500/50 bg-orange-500/10 px-2.5 py-1 text-xs font-medium text-orange-300 hover:bg-orange-500/20"
    >
      <span aria-hidden className="size-2 rounded-full bg-orange-500" />
      Système : {problems.length} point{problems.length > 1 ? 's' : ''} à vérifier
    </Link>
  )
}
