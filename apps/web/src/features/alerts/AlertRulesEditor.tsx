import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ErrorNote } from '../../components/ErrorNote'
import { btn, btnDanger, btnPrimary, card, input, mutedText } from '../../components/ui'
import { effectiveRule, formatMetric, METRICS, validateRule, type MetricMeta, type RuleInput } from '../../lib/alerts'
import { LIVE } from '../../lib/live'
import type { AlertRule, MetricPercentiles } from '../../lib/types'
import { useWorkspace } from '../workspace/useWorkspace'
import { createRule, deleteRule, fetchAlertRules, fetchPercentiles, refreshStatuses, updateRule } from './api'

interface Props {
  /** null = valeurs par défaut du workspace ; sinon surcharges de ce Server Cloud. */
  cloudId: string | null
  /** Cloud dont les mesures réelles servent d'aide au calibrage (facultatif). */
  calibrationCloudId: string | null
}

export function AlertRulesEditor({ cloudId, calibrationCloudId }: Props) {
  const { workspace, canWrite } = useWorkspace()
  const rules = useQuery({ queryKey: ['alert-rules'], queryFn: fetchAlertRules, refetchInterval: LIVE.slow })
  const percentiles = useQuery({
    queryKey: ['percentiles', calibrationCloudId],
    queryFn: () => fetchPercentiles(calibrationCloudId!),
    enabled: Boolean(calibrationCloudId),
    refetchInterval: LIVE.slow,
  })

  if (rules.isPending) return <p className={mutedText}>Chargement des règles…</p>
  if (rules.error) return <ErrorNote error={rules.error} />

  return (
    <div className="space-y-3">
      {METRICS.map((meta) => {
        const { rule, source } = effectiveRule(rules.data ?? [], meta.key, cloudId)
        return rule && workspace ? (
          <RuleRow
            key={`${meta.key}-${rule.id}-${rule.warn_threshold}-${rule.crit_threshold}-${rule.window_minutes}-${rule.min_breach_ratio}-${rule.recover_margin}-${rule.recover_minutes}-${rule.enabled}`}
            meta={meta}
            rule={rule}
            source={source}
            cloudId={cloudId}
            workspaceId={workspace.id}
            canWrite={canWrite}
            percentiles={percentiles.data?.find((p) => p.metric === meta.key)}
            calibrated={Boolean(calibrationCloudId)}
          />
        ) : null
      })}
    </div>
  )
}

interface RowProps {
  meta: MetricMeta
  rule: AlertRule
  source: 'cloud' | 'default'
  cloudId: string | null
  workspaceId: string
  canWrite: boolean
  percentiles: MetricPercentiles | undefined
  calibrated: boolean
}

function RuleRow({ meta, rule, source, cloudId, workspaceId, canWrite, percentiles, calibrated }: RowProps) {
  const queryClient = useQueryClient()
  const [warn, setWarn] = useState(String(rule.warn_threshold))
  const [crit, setCrit] = useState(String(rule.crit_threshold))
  const [windowMin, setWindowMin] = useState(String(rule.window_minutes))
  const [ratioPct, setRatioPct] = useState(String(Math.round(rule.min_breach_ratio * 100)))
  const [margin, setMargin] = useState(String(rule.recover_margin))
  const [recover, setRecover] = useState(String(rule.recover_minutes))
  const [enabled, setEnabled] = useState(rule.enabled)
  const [formError, setFormError] = useState<string | null>(null)
  const unit = meta.unit === 'percent' ? '%' : ''

  const after = async () => {
    // Recalcul immédiat des statuts : on voit tout de suite l'effet du nouveau seuil.
    await refreshStatuses().catch(() => undefined)
    await queryClient.invalidateQueries({ queryKey: ['alert-rules'] })
    await queryClient.invalidateQueries({ queryKey: ['cloud-statuses'] })
  }

  const save = useMutation({
    mutationFn: async (input: RuleInput) => {
      if (cloudId && source === 'default') await createRule(workspaceId, cloudId, meta.key, input)
      else await updateRule(rule.id, input)
    },
    onSuccess: after,
  })
  const reset = useMutation({ mutationFn: () => deleteRule(rule.id), onSuccess: after })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const input: RuleInput = {
      warn_threshold: Number(warn.replace(',', '.')),
      crit_threshold: Number(crit.replace(',', '.')),
      window_minutes: Number(windowMin),
      min_breach_ratio: Number(ratioPct) / 100,
      recover_margin: Number(margin.replace(',', '.')),
      recover_minutes: Number(recover),
      enabled,
    }
    const problem = validateRule(input)
    setFormError(problem)
    if (!problem) save.mutate(input)
  }

  const field = 'block text-xs font-medium text-slate-600 dark:text-slate-300'
  const small = `${input} mt-0.5 py-1.5`

  return (
    <form onSubmit={onSubmit} className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">
            {meta.label}
            {cloudId && (
              <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {source === 'cloud' ? 'Personnalisée pour ce Cloud' : 'Valeur par défaut'}
              </span>
            )}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{meta.help}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} disabled={!canWrite} onChange={(e) => setEnabled(e.target.checked)} />
          Règle active
        </label>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className={field}>
          Warning au-dessus de {unit && `(${unit})`}
          <input inputMode="decimal" className={small} value={warn} disabled={!canWrite} onChange={(e) => setWarn(e.target.value)} />
        </label>
        <label className={field}>
          Critical au-dessus de {unit && `(${unit})`}
          <input inputMode="decimal" className={small} value={crit} disabled={!canWrite} onChange={(e) => setCrit(e.target.value)} />
        </label>
        <label className={field}>
          Fenêtre (min)
          <input inputMode="numeric" className={small} value={windowMin} disabled={!canWrite} onChange={(e) => setWindowMin(e.target.value)} />
        </label>
        <label className={field}>
          Relevés au-dessus (%)
          <input inputMode="numeric" className={small} value={ratioPct} disabled={!canWrite} onChange={(e) => setRatioPct(e.target.value)} />
        </label>
        <label className={field}>
          Marge de retour {unit && `(${unit})`}
          <input inputMode="decimal" className={small} value={margin} disabled={!canWrite} onChange={(e) => setMargin(e.target.value)} />
        </label>
        <label className={field}>
          Retour stable (min)
          <input inputMode="numeric" className={small} value={recover} disabled={!canWrite} onChange={(e) => setRecover(e.target.value)} />
        </label>
      </div>

      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Alerte quand au moins {ratioPct || '…'} % des relevés des {windowMin || '…'} dernières minutes dépassent le seuil ;
        retour à la normale quand toutes les valeurs restent sous (seuil − marge) pendant {recover || '…'} minutes.
      </p>

      {calibrated && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {percentiles && percentiles.n > 0
            ? `Mesures réelles sur 7 jours (${percentiles.n} relevés) : médiane ${formatMetric(meta.key, percentiles.p50)} · p95 ${formatMetric(meta.key, percentiles.p95)} · p99 ${formatMetric(meta.key, percentiles.p99)} · max ${formatMetric(meta.key, percentiles.max)}`
            : 'Pas encore de mesures pour calibrer cette règle.'}
        </p>
      )}

      {(formError || save.error || reset.error) && (
        <div className="mt-2" role="alert">
          {formError ? <p className="text-sm text-red-600 dark:text-red-400">{formError}</p> : <ErrorNote error={save.error ?? reset.error} />}
        </div>
      )}

      {canWrite && (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {cloudId && source === 'cloud' && (
            <button type="button" className={btnDanger} disabled={reset.isPending} onClick={() => reset.mutate()}>
              Revenir à la valeur par défaut
            </button>
          )}
          <button type="submit" className={cloudId && source === 'default' ? btn : btnPrimary} disabled={save.isPending}>
            {save.isPending ? 'Enregistrement…' : cloudId && source === 'default' ? 'Personnaliser pour ce Cloud' : 'Enregistrer'}
          </button>
        </div>
      )}
    </form>
  )
}
