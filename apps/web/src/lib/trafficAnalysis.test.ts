import { describe, expect, it } from 'vitest'
import { analyzeTraffic, ruleAsText } from './trafficAnalysis'
import { buildChatGptReport, buildRulesText } from './trafficReport'
import type { TrafficView } from './trafficView'

const view = (over: Partial<TrafficView> = {}): TrafficView => ({
  scope: 'YellowTie-1',
  periodLabel: 'la dernière heure',
  minutes: 60,
  requests: 5000,
  totals: { r4xx: 100, r5xx: 10, posts: 800, bots: 200 },
  hostings: [],
  domains: [{ domain: 'exemple.fr', hosting: null, requests: 4000, r4xx: 50, r5xx: 5, posts: 700, bots: 100 }],
  paths: [],
  queries: [],
  uas: [],
  ips: [],
  ipdomains: [],
  domdetail: [],
  agents: null,
  sampled: false,
  detailed: true,
  ...over,
})

describe('analyzeTraffic', () => {
  it('ne trouve rien sans requêtes', () => {
    expect(analyzeTraffic(view({ requests: 0 }))).toEqual([])
  })

  it('ne trouve rien sur un trafic ordinaire', () => {
    const v = view({ paths: [{ domain: 'exemple.fr', path: '/', requests: 300, errors: 0, posts: 0 }] })
    expect(analyzeTraffic(v).filter((f) => f.severity === 'high')).toEqual([])
  })

  it('détecte des tentatives de connexion et propose défi géré + limitation de débit', () => {
    const v = view({ paths: [{ domain: 'exemple.fr', path: '/wp-login.php', requests: 900, errors: 0, posts: 800 }] })
    const f = analyzeTraffic(v).find((x) => x.kind === 'login_abuse')
    expect(f).toBeDefined()
    expect(f?.severity).toBe('high')
    expect(f?.rules.map((r) => r.action)).toEqual(['managed_challenge', 'rate_limit'])
    expect(f?.rules[0]?.expression).toContain('http.host in {"exemple.fr" "www.exemple.fr"}')
    expect(f?.rules[0]?.expression).toContain('/wp-login.php')
  })

  it('détecte xmlrpc sans lier la règle à WooCommerce', () => {
    const v = view({ paths: [{ domain: 'exemple.fr', path: '/xmlrpc.php', requests: 500, errors: 0, posts: 500 }] })
    const f = analyzeTraffic(v).find((x) => x.kind === 'xmlrpc')
    expect(f).toBeDefined()
    expect(JSON.stringify(f)).not.toMatch(/woocommerce/i)
  })

  it('trie les constats du plus grave au moins grave', () => {
    const v = view({
      paths: [
        { domain: 'exemple.fr', path: '/wp-login.php', requests: 900, errors: 0, posts: 800 },
        { domain: 'exemple.fr', path: '/xmlrpc.php', requests: 30, errors: 0, posts: 30 },
      ],
    })
    const order = { high: 0, medium: 1, info: 2 }
    const sev = analyzeTraffic(v).map((f) => order[f.severity])
    expect(sev).toEqual([...sev].sort((a, b) => a - b))
  })
})

describe('textes prêts à copier', () => {
  const v = view({ paths: [{ domain: 'exemple.fr', path: '/wp-login.php', requests: 900, errors: 0, posts: 800 }], ips: [{ ip: '203.0.113.9', requests: 700 }] })

  it('la règle complète indique le chemin dans Cloudflare', () => {
    const rule = analyzeTraffic(v)[0]!.rules[0]!
    const text = ruleAsText(rule)
    expect(text).toContain('Expression :')
    expect(text).toContain('Règles personnalisées')
  })

  it('le rapport ChatGPT contient chiffres, IP, constats et la mission (sans ligne brute)', () => {
    const r = buildChatGptReport(v, { incident: { cloud: 'Cloud 2', kind: 'performance', severity: 'critical', startedAt: 'hier', endedAt: null, peaks: ['Load 51'] } })
    expect(r).toContain('Cloud 2')
    expect(r).toContain('exemple.fr/wp-login.php')
    expect(r).toContain('203.0.113.9')
    expect(r).toContain('règles Cloudflare')
    expect(r).toContain('pas uniquement WooCommerce')
    expect(r).toContain('en cours')
  })

  it('toutes les règles sont regroupées', () => {
    expect(buildRulesText(analyzeTraffic(v))).toContain('Nom :')
  })
})
