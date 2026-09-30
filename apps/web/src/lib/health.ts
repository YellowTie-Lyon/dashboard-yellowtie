import type { JobState } from './types'

/** Quota de la base Supabase (offre Free : 500 Mo). À adapter si le projet passe en Pro. */
export const DB_QUOTA_BYTES = 500 * 1024 * 1024

export type JobLevel = 'ok' | 'late' | 'never'

export interface JobSpec {
  name: string
  label: string
  /** Périodicité prévue et retard toléré avant alerte (ms). */
  everyMs: number
  lateAfterMs: number
  /** Si absent, un tâche jamais exécutée est un problème (sinon simplement « en attente »). */
  criticalIfMissing: boolean
}

const MIN = 60_000
const HOUR = 60 * MIN

export const JOBS: JobSpec[] = [
  { name: 'evaluate', label: 'Évaluation des statuts', everyMs: MIN, lateAfterMs: 5 * MIN, criticalIfMissing: true },
  { name: 'rollup', label: 'Agrégation horaire des mesures', everyMs: 5 * MIN, lateAfterMs: 20 * MIN, criticalIfMissing: true },
  { name: 'traffic', label: 'Agrégation du trafic', everyMs: 10 * MIN, lateAfterMs: 40 * MIN, criticalIfMissing: false },
  { name: 'probes', label: 'Sondes HTTP', everyMs: MIN, lateAfterMs: 10 * MIN, criticalIfMissing: false },
  { name: 'purge', label: 'Purge des mesures anciennes', everyMs: 24 * HOUR, lateAfterMs: 26 * HOUR, criticalIfMissing: false },
  { name: 'traffic_purge', label: 'Purge du trafic ancien', everyMs: 24 * HOUR, lateAfterMs: 26 * HOUR, criticalIfMissing: false },
]

export interface JobHealth {
  spec: JobSpec
  level: JobLevel
  lastRunAt: string | null
  /** Vrai si cette situation doit être signalée comme un problème. */
  problem: boolean
}

export function jobHealth(spec: JobSpec, states: JobState[], now: number): JobHealth {
  const state = states.find((s) => s.name === spec.name)
  if (!state) return { spec, level: 'never', lastRunAt: null, problem: spec.criticalIfMissing }
  const late = now - new Date(state.last_run_at).getTime() > spec.lateAfterMs
  return { spec, level: late ? 'late' : 'ok', lastRunAt: state.last_run_at, problem: late }
}

export type StorageLevel = 'ok' | 'warning' | 'critical'

export function storageLevel(usedBytes: number, quotaBytes: number = DB_QUOTA_BYTES): StorageLevel {
  const ratio = usedBytes / quotaBytes
  return ratio >= 0.9 ? 'critical' : ratio >= 0.7 ? 'warning' : 'ok'
}

/** 12,5 Mo · 1,2 Go */
export function formatSize(bytes: number): string {
  const units = ['o', 'Ko', 'Mo', 'Go']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: v >= 100 || i === 0 ? 0 : 1 })} ${units[i]}`
}
