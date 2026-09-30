import { describe, expect, it } from 'vitest'
import { agentHealth, effectiveRule, formatMetric, METRICS, reasonShort, reasonText, statusSummary, validateRule, type RuleInput } from './alerts'
import type { AlertRule, CloudStatusRow, StatusReason } from './types'

const base: RuleInput = { warn_threshold: 0.6, crit_threshold: 1, window_minutes: 5, min_breach_ratio: 0.8, recover_margin: 0.1, recover_minutes: 5, enabled: true }

function rule(over: Partial<AlertRule>): AlertRule {
  return { id: 'r', workspace_id: 'w', cloud_server_id: null, metric: 'cpu_pct', ...base, ...over }
}

describe('METRICS', () => {
  it('couvre les huit métriques sans doublon', () => {
    expect(new Set(METRICS.map((m) => m.key)).size).toBe(8)
  })
})

describe('effectiveRule', () => {
  const rules = [rule({ id: 'd', warn_threshold: 75 }), rule({ id: 'c1', cloud_server_id: 'c1', warn_threshold: 70 })]

  it('prend la surcharge du Cloud quand elle existe', () => {
    const e = effectiveRule(rules, 'cpu_pct', 'c1')
    expect(e.source).toBe('cloud')
    expect(e.rule?.id).toBe('c1')
  })

  it('retombe sur la valeur par défaut pour un autre Cloud ou sans Cloud', () => {
    expect(effectiveRule(rules, 'cpu_pct', 'c2').source).toBe('default')
    expect(effectiveRule(rules, 'cpu_pct', null).rule?.id).toBe('d')
  })

  it('renvoie undefined pour une métrique sans règle', () => {
    expect(effectiveRule(rules, 'load1', 'c1').rule).toBeUndefined()
  })
})

describe('validateRule', () => {
  it('accepte une règle valide', () => {
    expect(validateRule(base)).toBeNull()
  })

  it.each([
    [{ crit_threshold: 0.6 }, /strictement supérieur/],
    [{ crit_threshold: 0.5 }, /strictement supérieur/],
    [{ warn_threshold: -1 }, /positif/],
    [{ window_minutes: 0 }, /fenêtre/],
    [{ window_minutes: 61 }, /fenêtre/],
    [{ window_minutes: 2.5 }, /entier/],
    [{ min_breach_ratio: 0.05 }, /10 % et 100 %/],
    [{ min_breach_ratio: 1.2 }, /10 % et 100 %/],
    [{ recover_margin: -0.1 }, /négative/],
    [{ recover_margin: 0.6 }, /inférieure au seuil Warning/],
    [{ recover_minutes: 0 }, /retour stable/],
    [{ recover_minutes: 121 }, /retour stable/],
    [{ warn_threshold: Number.NaN }, /nombres/],
  ])('refuse %j', (over, message) => {
    expect(validateRule({ ...base, ...over })).toMatch(message)
  })
})

describe('textes', () => {
  const reason: StatusReason = { metric: 'load1_per_core', level: 'warning', value: 1.12, warn: 0.6, crit: 1.5, since: '2026-09-30T10:00:00Z' }

  it('formate un pourcentage et une charge', () => {
    expect(formatMetric('cpu_pct', 87.4)).toBe('87,4 %')
    expect(formatMetric('load1', 4.82)).toBe('4,82')
  })

  it('décrit une raison de statut avec ses seuils', () => {
    expect(reasonText(reason)).toBe('Load 1 min par cœur : 1,12 (Warning dès 0,60, Critical dès 1,50)')
    expect(reasonShort(reason)).toBe('Load 1 min par cœur 1,12')
  })
})

describe('agentHealth', () => {
  const now = Date.parse('2026-09-30T10:00:00Z')
  it.each([
    [null, 'never'],
    ['2026-09-30T09:59:40Z', 'ok'],
    ['2026-09-30T09:58:00Z', 'delayed'],
    ['2026-09-30T09:50:00Z', 'silent'],
  ])('dernier heartbeat %s → %s', (seen, expected) => {
    expect(agentHealth(seen, 240, now)).toBe(expected)
  })
})

describe('statusSummary', () => {
  function row(status: CloudStatusRow['status'], detail: Partial<CloudStatusRow['detail']> = {}): CloudStatusRow {
    return {
      cloud_server_id: 'c', status, status_since: '', evaluated_at: '',
      detail: { reasons: [], connectivity: 'ok', offline_diagnosis: null, last_agent_seen: null, metrics_received: null, ...detail },
    }
  }
  const r1: StatusReason = { metric: 'cpu_pct', level: 'critical', value: 93, warn: 75, crit: 90, since: '' }
  const r2: StatusReason = { metric: 'mem_used_pct', level: 'warning', value: 88, warn: 85, crit: 95, since: '' }

  it('résume la première raison et compte les autres', () => {
    expect(statusSummary(row('critical', { reasons: [r1, r2] }))).toBe('CPU 93 % (+1)')
    expect(statusSummary(row('warning', { reasons: [r2] }))).toBe('RAM utilisée 88 %')
  })

  it('explique un Cloud hors ligne avec prudence', () => {
    expect(statusSummary(row('offline', { offline_diagnosis: 'agents_silent' }))).toMatch(/sondes répondent/)
    expect(statusSummary(row('offline', { offline_diagnosis: 'unreachable_probable' }))).toMatch(/sondes en échec/)
    expect(statusSummary(row('offline', { offline_diagnosis: 'unknown_cause' }))).toBe('Aucun agent ne répond')
  })

  it('explique les données absentes ou obsolètes et la maintenance', () => {
    expect(statusSummary(row('unknown', { connectivity: 'metrics_stale' }))).toBe('Collecteur système silencieux')
    expect(statusSummary(row('unknown', { connectivity: 'never' }))).toBe("Aucun agent installé")
    expect(statusSummary(row('maintenance'))).toBe('Alertes suspendues')
  })

  it('ne dit rien quand tout va bien', () => {
    expect(statusSummary(row('normal'))).toBeNull()
    expect(statusSummary(undefined)).toBeNull()
  })
})
