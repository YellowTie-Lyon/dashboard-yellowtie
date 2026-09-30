import type { TrafficView } from './trafficView'

/**
 * Détection de motifs de trafic à partir des AGRÉGATS de l'agent, et règles Cloudflare correspondantes.
 *
 * Principes :
 *  - un volume élevé n'est jamais une preuve : chaque constat expose ses chiffres, ses réserves et ce qu'il faut vérifier ;
 *  - les règles sont des SUGGESTIONS à copier dans Cloudflare : YellowScope n'applique jamais rien à votre place ;
 *  - les expressions n'emploient que des opérateurs disponibles sur toutes les offres (eq, contains, starts_with, in, ip.src) ;
 *  - un « défi géré » (Managed Challenge) est proposé avant un blocage, sauf pour les cas sans usage légitime (.env, xmlrpc…) ;
 *  - jamais de défi sur les appels XHR/API (wp-json, admin-ajax, wc-ajax) : il les casserait ; on propose une limitation de débit.
 */

export type RuleAction = 'managed_challenge' | 'block' | 'rate_limit'

export interface CloudflareRule {
  name: string
  action: RuleAction
  expression: string
  rateLimit?: { requests: number; periodSeconds: number; timeoutSeconds: number }
  note?: string
}

export type FindingKind =
  | 'login_abuse'
  | 'xmlrpc'
  | 'query_flood'
  | 'scanner'
  | 'rest_api'
  | 'ajax_abuse'
  | 'ip_concentration'
  | 'bad_bots'
  | 'errors'
  | 'concentration'

export interface Finding {
  id: string
  kind: FindingKind
  severity: 'high' | 'medium' | 'info'
  title: string
  evidence: string
  domain?: string
  /** Réserves : ce qu'il faut vérifier avant d'appliquer la règle. */
  cautions: string[]
  rules: CloudflareRule[]
}

const pct = (part: number, total: number) => (total > 0 ? (100 * part) / total : 0)
const fmtPct = (n: number) => `${Math.round(n)} %`
const fmtN = (n: number) => n.toLocaleString('fr-FR')

/** Chaîne entre guillemets pour une expression Cloudflare (les valeurs sont déjà assainies par l'agent et la base). */
export const cfString = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Condition sur le nom d'hôte : le domaine remonté par l'agent n'a plus son « www. ». */
export function hostCondition(domain: string | undefined): string | null {
  if (!domain || domain === '(autre)' || !/^[a-z0-9.-]+$/.test(domain)) return null
  return `http.host in {${cfString(domain)} ${cfString('www.' + domain)}}`
}

const and = (...parts: (string | null | false)[]) => parts.filter((p): p is string => Boolean(p)).join(' and ')
const group = (parts: string[]) => (parts.length > 1 ? `(${parts.join(' or ')})` : (parts[0] ?? ''))

/** « ...?orderby=… » : le nom de paramètre doit être en début de query ou après un « & » (évite de matcher « class= » pour « s= »). */
function queryParam(name: string): string {
  return `(starts_with(http.request.uri.query, ${cfString(name + '=')}) or http.request.uri.query contains ${cfString('&' + name + '=')})`
}

const NOT_BOT = 'not cf.client.bot'
const NOT_LOGGED = `not http.cookie contains ${cfString('wordpress_logged_in')}`

const sumBy = <T,>(items: T[], f: (t: T) => number) => items.reduce((n, i) => n + f(i), 0)

// ---------------------------------------------------------------------------------------------------------------------------------
// Détecteurs
// ---------------------------------------------------------------------------------------------------------------------------------

function domainRequests(v: TrafficView, domain: string): number {
  return v.domains.find((d) => d.domain === domain)?.requests ?? 0
}

const basePath = (p: string) => p.split('?')[0] ?? p

function detectLoginAbuse(v: TrafficView): Finding[] {
  const out: Finding[] = []
  const byDomain = new Map<string, { req: number; posts: number }>()
  for (const p of v.paths) {
    if (basePath(p.path) !== '/wp-login.php') continue
    const e = byDomain.get(p.domain) ?? { req: 0, posts: 0 }
    e.req += p.requests
    e.posts += p.posts
    byDomain.set(p.domain, e)
  }
  for (const [domain, e] of byDomain) {
    const share = pct(e.req, domainRequests(v, domain) || v.requests)
    if (e.req < 60 || (e.posts < 30 && share < 15)) continue
    const host = hostCondition(domain)
    const base = and(host, 'http.request.uri.path eq "/wp-login.php"', 'http.request.method eq "POST"')
    out.push({
      id: `login:${domain}`,
      kind: 'login_abuse',
      severity: e.req >= 300 || share >= 40 ? 'high' : 'medium',
      domain,
      title: `Tentatives de connexion répétées sur ${domain}`,
      evidence: `${fmtN(e.req)} requêtes vers /wp-login.php (${fmtPct(share)} du trafic du domaine), dont ${fmtN(e.posts)} en POST.`,
      cautions: [
        'Vérifiez que ce n’est pas vous ou une équipe qui se connecte fréquemment (partage d’IP, outils de déploiement).',
        'Le défi géré ne gêne pas un vrai utilisateur ; pour aller plus loin : double authentification WordPress ou limitation des tentatives.',
      ],
      rules: [
        { name: `Défi géré connexion WordPress ${domain}`, action: 'managed_challenge', expression: base },
        {
          name: `Limitation de débit connexion ${domain}`,
          action: 'rate_limit',
          expression: base,
          rateLimit: { requests: 5, periodSeconds: 10, timeoutSeconds: 10 },
          note: 'Compte par adresse IP. L’offre Free autorise 1 règle de limitation, période de 10 s et blocage de 10 s ; les offres supérieures permettent des durées plus longues.',
        },
      ],
    })
  }
  return out
}

function detectXmlrpc(v: TrafficView): Finding[] {
  const out: Finding[] = []
  const byDomain = new Map<string, number>()
  for (const p of v.paths) if (basePath(p.path) === '/xmlrpc.php') byDomain.set(p.domain, (byDomain.get(p.domain) ?? 0) + p.requests)
  for (const [domain, n] of byDomain) {
    if (n < 20) continue
    out.push({
      id: `xmlrpc:${domain}`,
      kind: 'xmlrpc',
      severity: n >= 200 ? 'high' : 'medium',
      domain,
      title: `Sollicitations de xmlrpc.php sur ${domain}`,
      evidence: `${fmtN(n)} requêtes vers /xmlrpc.php.`,
      cautions: ['xmlrpc.php sert surtout aux attaques (force brute, amplification). À conserver seulement si Jetpack ou l’application mobile WordPress l’utilise.'],
      rules: [{ name: `Bloquer xmlrpc.php ${domain}`, action: 'block', expression: and(hostCondition(domain), 'http.request.uri.path eq "/xmlrpc.php"') }],
    })
  }
  return out
}

interface QueryRule {
  label: string
  match: (names: string[]) => string | null
  build: (domain: string, token: string) => string
  navigation: boolean
}

const QUERY_RULES: QueryRule[] = [
  {
    label: 'filtres WooCommerce',
    match: (n) => n.find((x) => x.startsWith('filter_')) ?? n.find((x) => x.startsWith('query_type_')) ?? n.find((x) => ['min_price', 'max_price', 'rating_filter'].includes(x)) ?? null,
    build: (d, tok) => and(hostCondition(d), tok.endsWith('_') ? `http.request.uri.query contains ${cfString(tok)}` : queryParam(tok), NOT_BOT),
    navigation: true,
  },
  { label: 'recherche interne (?s=)', match: (n) => (n.includes('s') ? 's' : null), build: (d, tok) => and(hostCondition(d), queryParam(tok), NOT_BOT), navigation: true },
  { label: 'ajout au panier (?add-to-cart=)', match: (n) => (n.includes('add-to-cart') ? 'add-to-cart' : null), build: (d, tok) => and(hostCondition(d), queryParam(tok), NOT_BOT), navigation: true },
  { label: 'tri (?orderby=)', match: (n) => (n.includes('orderby') ? 'orderby' : null), build: (d, tok) => and(hostCondition(d), queryParam(tok), NOT_BOT), navigation: true },
  { label: 'pagination profonde (?paged=)', match: (n) => n.find((x) => x === 'paged' || x === 'page') ?? null, build: (d, tok) => and(hostCondition(d), queryParam(tok), NOT_BOT), navigation: true },
  { label: 'commentaires / réponses (?replytocom=)', match: (n) => (n.includes('replytocom') ? 'replytocom' : null), build: (d, tok) => and(hostCondition(d), queryParam(tok), NOT_BOT), navigation: true },
  { label: 'énumération d’auteurs (?author=)', match: (n) => (n.includes('author') ? 'author' : null), build: (d, tok) => and(hostCondition(d), queryParam(tok), NOT_LOGGED), navigation: true },
  { label: 'API REST par paramètre (?rest_route=)', match: (n) => (n.includes('rest_route') ? 'rest_route' : null), build: (d, tok) => and(hostCondition(d), queryParam(tok), NOT_LOGGED), navigation: false },
]

function detectQueryFloods(v: TrafficView): Finding[] {
  const out: Finding[] = []
  const done = new Set<string>()
  for (const q of v.queries) {
    const domReq = domainRequests(v, q.domain) || v.requests
    const share = pct(q.requests, domReq)
    if (q.requests < 80 || share < 15) continue
    const names = q.query.split(',').filter((x) => x && x !== '+')
    let matched: { rule: QueryRule; token: string } | null = null
    for (const rule of QUERY_RULES) {
      const token = rule.match(names)
      if (token) {
        matched = { rule, token }
        break
      }
    }
    const generic = !matched && share >= 25 && q.requests >= 100 && names.length > 0
    if (!matched && !generic) continue
    const key = `${q.domain}|${matched?.rule.label ?? names[0]}`
    if (done.has(key)) continue
    done.add(key)
    const label = matched?.rule.label ?? `paramètre « ${names[0]} »`
    const token = matched?.token ?? names[0]!
    const expression = matched ? matched.rule.build(q.domain, token) : and(hostCondition(q.domain), queryParam(token), NOT_BOT)
    const navigation = matched?.rule.navigation ?? true
    out.push({
      id: `query:${key}`,
      kind: 'query_flood',
      severity: share >= 40 ? 'high' : 'medium',
      domain: q.domain,
      title: `Trafic massif sur ${label} · ${q.domain}`,
      evidence: `${fmtN(q.requests)} requêtes (${fmtPct(share)} du trafic du domaine) avec le motif de paramètres « ${q.query} »${q.errors > 0 ? `, dont ${fmtN(q.errors)} en erreur` : ''}.`,
      cautions: [
        'Ces requêtes contournent le cache (URL toutes différentes) et sollicitent PHP et la base : c’est typique d’un robot qui parcourt les combinaisons de filtres.',
        navigation
          ? 'Le défi géré est réservé aux pages consultées par un navigateur ; « not cf.client.bot » laisse passer les robots vérifiés (Googlebot…), à retirer si vous voulez aussi les limiter.'
          : 'Appel d’API : préférez une limitation de débit à un défi (un défi casse les appels automatiques du site).',
        'Vérifiez dans Cloudflare > Sécurité > Événements que la règle ne touche que le trafic voulu avant de passer d’un défi à un blocage.',
      ],
      rules: [
        navigation
          ? { name: `Défi géré ${label} ${q.domain}`, action: 'managed_challenge', expression }
          : { name: `Limitation ${label} ${q.domain}`, action: 'rate_limit', expression, rateLimit: { requests: 10, periodSeconds: 10, timeoutSeconds: 10 } },
      ],
    })
  }
  return out
}

const SCANNER_TOKENS = ['/.env', '/.git', '/wp-config', '/phpmyadmin', '/vendor/phpunit', '/cgi-bin', '/etc/passwd', '.sql', '.bak', '/backup', '/shell', 'eval-stdin', '/.aws', '/.ssh']

function detectScanners(v: TrafficView): Finding[] {
  const out: Finding[] = []
  const byDomain = new Map<string, { tokens: Set<string>; req: number }>()
  for (const p of v.paths) {
    const low = p.path.toLowerCase()
    const hits = SCANNER_TOKENS.filter((t) => low.includes(t))
    if (hits.length === 0) continue
    const e = byDomain.get(p.domain) ?? { tokens: new Set<string>(), req: 0 }
    hits.forEach((h) => e.tokens.add(h))
    e.req += p.requests
    byDomain.set(p.domain, e)
  }
  for (const [domain, e] of byDomain) {
    if (e.req < 10) continue
    const tokens = [...e.tokens]
    out.push({
      id: `scanner:${domain}`,
      kind: 'scanner',
      severity: e.req >= 100 ? 'high' : 'medium',
      domain,
      title: `Recherche de fichiers sensibles sur ${domain}`,
      evidence: `${fmtN(e.req)} requêtes vers des chemins typiques de scanners (${tokens.join(', ')}).`,
      cautions: ['Aucun visiteur légitime ne demande ces chemins : blocage sans risque pour les vrais utilisateurs.'],
      rules: [{ name: `Bloquer les scanners ${domain}`, action: 'block', expression: and(hostCondition(domain), group(tokens.map((t) => `http.request.uri.path contains ${cfString(t)}`))) }],
    })
  }
  for (const d of v.domdetail) {
    const req = domainRequests(v, d.domain)
    if (byDomain.has(d.domain) || d.notFound < 100 || d.distinctPaths < 50 || pct(d.notFound, req) < 30) continue
    out.push({
      id: `scan404:${d.domain}`,
      kind: 'scanner',
      severity: 'medium',
      domain: d.domain,
      title: `Balayage d’URL inexistantes sur ${d.domain}`,
      evidence: `${fmtN(d.notFound)} réponses 404 (${fmtPct(pct(d.notFound, req))} du trafic du domaine) sur au moins ${fmtN(d.distinctPaths)} URL différentes.`,
      cautions: [
        'Un balayage se combat par adresse IP : voir les IP les plus actives de ce domaine ci-dessous (règle « IP » si l’une domine).',
        'Vérifiez aussi que la page 404 de WordPress n’est pas coûteuse (thème, plugins) : mettre les 404 en cache allège fortement le serveur.',
      ],
      rules: [],
    })
  }
  return out
}

function detectRestApi(v: TrafficView): Finding[] {
  const out: Finding[] = []
  const byDomain = new Map<string, { req: number; users: number }>()
  for (const p of v.paths) {
    const b = basePath(p.path)
    if (!b.startsWith('/wp-json')) continue
    const e = byDomain.get(p.domain) ?? { req: 0, users: 0 }
    e.req += p.requests
    if (b.includes('/wp/v2/users')) e.users += p.requests
    byDomain.set(p.domain, e)
  }
  for (const [domain, e] of byDomain) {
    const share = pct(e.req, domainRequests(v, domain) || v.requests)
    if (e.req < 80 || share < 15) continue
    const host = hostCondition(domain)
    const rules: CloudflareRule[] = []
    if (e.users >= 10) {
      rules.push({
        name: `Bloquer l’énumération des utilisateurs ${domain}`,
        action: 'block',
        expression: and(host, 'http.request.uri.path contains "/wp-json/wp/v2/users"', NOT_LOGGED),
        note: 'Sans effet pour les administrateurs connectés (cookie de session WordPress).',
      })
    }
    rules.push({
      name: `Limitation API REST ${domain}`,
      action: 'rate_limit',
      expression: and(host, 'starts_with(http.request.uri.path, "/wp-json/")', NOT_LOGGED),
      rateLimit: { requests: 30, periodSeconds: 10, timeoutSeconds: 10 },
      note: 'Limitation plutôt que défi : un défi casserait les appels automatiques de vos pages et de votre boutique.',
    })
    out.push({
      id: `rest:${domain}`,
      kind: 'rest_api',
      severity: share >= 40 ? 'high' : 'medium',
      domain,
      title: `Forte activité sur l’API REST de ${domain}`,
      evidence: `${fmtN(e.req)} requêtes vers /wp-json (${fmtPct(share)} du trafic du domaine)${e.users >= 10 ? `, dont ${fmtN(e.users)} sur la liste des utilisateurs` : ''}.`,
      cautions: ['L’API REST est aussi utilisée par l’éditeur de blocs, certains plugins et le tableau de bord : testez après application.'],
      rules,
    })
  }
  return out
}

function detectAjaxAbuse(v: TrafficView): Finding[] {
  const out: Finding[] = []
  const byDomain = new Map<string, number>()
  for (const p of v.paths) {
    const b = basePath(p.path)
    if (b === '/wp-admin/admin-ajax.php' || b === '/' && p.path.includes('wc-ajax')) byDomain.set(p.domain, (byDomain.get(p.domain) ?? 0) + p.requests)
  }
  for (const [domain, n] of byDomain) {
    const share = pct(n, domainRequests(v, domain) || v.requests)
    if (n < 100 || share < 15) continue
    out.push({
      id: `ajax:${domain}`,
      kind: 'ajax_abuse',
      severity: share >= 40 ? 'high' : 'medium',
      domain,
      title: `Appels admin-ajax.php en masse sur ${domain}`,
      evidence: `${fmtN(n)} requêtes vers admin-ajax.php (${fmtPct(share)} du trafic du domaine).`,
      cautions: [
        'admin-ajax.php sert aussi aux fonctions légitimes du site (formulaires, panier, recherche instantanée) : une limitation de débit est plus sûre qu’un blocage.',
        'Cherchez le plugin ou le thème responsable de ces appels (paramètre « action= » dans les logs) : c’est souvent la vraie source du problème.',
      ],
      rules: [
        {
          name: `Limitation admin-ajax ${domain}`,
          action: 'rate_limit',
          expression: and(hostCondition(domain), 'http.request.uri.path eq "/wp-admin/admin-ajax.php"', 'http.request.method eq "POST"', NOT_LOGGED),
          rateLimit: { requests: 20, periodSeconds: 10, timeoutSeconds: 10 },
        },
      ],
    })
  }
  return out
}

const GOOGLEBOT_IP = /^66\.249\./

/** Regroupe les IPv4 d'un même /24 (nombreux attaquants tournent dans le même bloc). */
function slash24(ip: string): string | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/)
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : null
}

function detectIps(v: TrafficView): Finding[] {
  const out: Finding[] = []
  const T = v.requests
  const list = v.ips
  const seenNets = new Set<string>()
  for (const { ip, requests } of list.slice(0, 5)) {
    const share = pct(requests, T)
    const dom = v.ipdomains.filter((x) => x.ip === ip).sort((a, b) => b.requests - a.requests)[0]
    const domShare = dom ? pct(dom.requests, domainRequests(v, dom.domain)) : 0
    if (requests < 150 || (share < 15 && domShare < 40)) continue
    if (GOOGLEBOT_IP.test(ip)) {
      out.push({
        id: `ip:${ip}`,
        kind: 'ip_concentration',
        severity: 'info',
        title: `L’IP ${ip} est très active (probablement Googlebot)`,
        evidence: `${fmtN(requests)} requêtes (${fmtPct(share)} du trafic). La plage 66.249.x.x appartient à Google.`,
        cautions: ['Ne bloquez pas Googlebot : limitez plutôt l’exploration dans Google Search Console ou évitez les URL à paramètres avec un robots.txt.'],
        rules: [],
      })
      continue
    }
    const net = slash24(ip)
    const sameNet = net ? list.filter((x) => slash24(x.ip) === net) : []
    const useNet = net !== null && sameNet.length >= 2 && !seenNets.has(net)
    if (net) seenNets.add(net)
    const target = useNet ? `ip.src in {${net}}` : `ip.src eq ${ip}`
    const total = useNet ? sumBy(sameNet, (x) => x.requests) : requests
    out.push({
      id: `ip:${useNet ? net : ip}`,
      kind: 'ip_concentration',
      severity: share >= 40 ? 'high' : 'medium',
      domain: dom?.domain,
      title: useNet ? `Un bloc d’adresses (${net}) génère beaucoup de trafic` : `Une seule adresse IP (${ip}) génère beaucoup de trafic`,
      evidence: `${fmtN(total)} requêtes (${fmtPct(pct(total, T))} du trafic analysé)${dom ? `, surtout sur ${dom.domain}` : ''}.`,
      cautions: [
        'Vérifiez que ce n’est pas votre propre adresse, un outil de supervision, une passerelle de paiement ou un partenaire.',
        'Si vos sites sont derrière Cloudflare et que les logs affichent des adresses Cloudflare (104.x, 172.64.x, 162.158.x…), l’IP réelle n’est pas restaurée : la règle serait sans effet.',
        'Commencez par un défi géré ; passez au blocage si le trafic persiste.',
      ],
      rules: [{ name: `Défi géré ${useNet ? net : ip}`, action: 'managed_challenge', expression: target }],
    })
  }
  return out
}

interface BotClass {
  label: string
  tokens: string[]
  action: RuleAction
  caution: string
}

const BOT_CLASSES: BotClass[] = [
  {
    label: 'robots SEO et d’indexation IA agressifs',
    tokens: ['AhrefsBot', 'SemrushBot', 'MJ12bot', 'DotBot', 'Bytespider', 'PetalBot', 'DataForSeoBot', 'BLEXBot', 'SeekportBot', 'GPTBot', 'ClaudeBot', 'CCBot', 'Amazonbot'],
    action: 'block',
    caution: 'Retirez de la liste les robots que vous acceptez (par exemple GPTBot/ClaudeBot si vous souhaitez apparaître dans les IA). Googlebot et Bingbot ne sont jamais concernés.',
  },
  {
    label: 'outils automatisés (scripts, aspirateurs)',
    tokens: ['python-requests', 'python-urllib', 'curl/', 'Wget/', 'Go-http-client', 'Scrapy', 'libwww-perl', 'HeadlessChrome', 'PhantomJS'],
    action: 'managed_challenge',
    caution: 'Vos propres scripts, outils de supervision (dont YellowScope si un jour ils appelaient le site) et certains services de paiement peuvent utiliser ces identifiants.',
  },
]

function detectBots(v: TrafficView): Finding[] {
  const out: Finding[] = []
  const T = v.requests
  for (const cls of BOT_CLASSES) {
    const hits = new Map<string, number>()
    for (const u of v.uas) {
      const low = u.ua.toLowerCase()
      const tok = cls.tokens.find((t) => low.includes(t.toLowerCase()))
      if (tok) hits.set(tok, (hits.get(tok) ?? 0) + u.requests)
    }
    const n = sumBy([...hits.values()], (x) => x)
    if (n < 100 || pct(n, T) < 10) continue
    const tokens = [...hits.keys()]
    out.push({
      id: `bots:${cls.label}`,
      kind: 'bad_bots',
      severity: pct(n, T) >= 30 ? 'high' : 'medium',
      title: `Trafic important de ${cls.label}`,
      evidence: `${fmtN(n)} requêtes (${fmtPct(pct(n, T))} du trafic analysé) : ${[...hits].map(([t, c]) => `${t} ${fmtN(c)}`).join(', ')}.`,
      cautions: [cls.caution],
      rules: [{ name: `${cls.action === 'block' ? 'Bloquer' : 'Défi géré'} ${cls.label}`, action: cls.action, expression: group(tokens.map((t) => `http.user_agent contains ${cfString(t)}`)) }],
    })
  }
  const empty = v.uas.find((u) => u.ua === '(vide)')
  if (empty && empty.requests >= 100 && pct(empty.requests, T) >= 10) {
    out.push({
      id: 'bots:empty',
      kind: 'bad_bots',
      severity: 'medium',
      title: 'Trafic important sans identifiant de navigateur (user-agent vide)',
      evidence: `${fmtN(empty.requests)} requêtes (${fmtPct(pct(empty.requests, T))} du trafic analysé) sans user-agent.`,
      cautions: ['Un navigateur réel envoie toujours un user-agent ; certains outils de supervision ou flux d’intégration n’en envoient pas : vérifiez.'],
      rules: [{ name: 'Défi géré sans user-agent', action: 'managed_challenge', expression: 'http.user_agent eq ""' }],
    })
  }
  return out
}

function detectErrors(v: TrafficView): Finding[] {
  const out: Finding[] = []
  for (const p of v.paths) {
    if (p.errors < 20 || p.requests < 40 || pct(p.errors, p.requests) < 30) continue
    if (SCANNER_TOKENS.some((t) => p.path.toLowerCase().includes(t))) continue
    out.push({
      id: `errors:${p.domain}${p.path}`,
      kind: 'errors',
      severity: 'info',
      domain: p.domain,
      title: `URL en erreur : ${p.domain}${p.path}`,
      evidence: `${fmtN(p.errors)} réponses en erreur (4xx/5xx) sur ${fmtN(p.requests)} requêtes (${fmtPct(pct(p.errors, p.requests))}).`,
      cautions: ['Un site qui répond en erreur sous la charge aggrave le problème (les robots réessaient). Vérifiez la santé de la page et envisagez une mise en cache des réponses publiques.'],
      rules: [],
    })
  }
  return out.slice(0, 3)
}

function detectConcentration(v: TrafficView): Finding[] {
  const top = [...v.domains].sort((a, b) => b.requests - a.requests)[0]
  if (!top || top.requests < 300 || pct(top.requests, v.requests) < 60) return []
  return [
    {
      id: `conc:${top.domain}`,
      kind: 'concentration',
      severity: 'info',
      domain: top.domain,
      title: `${top.domain} concentre l’essentiel du trafic`,
      evidence: `${fmtN(top.requests)} requêtes, soit ${fmtPct(pct(top.requests, v.requests))} du trafic analysé${top.hosting ? ` (hébergement ${top.hosting})` : ''}.`,
      cautions: ['Un volume élevé n’est pas forcément anormal (campagne, pic de saison). Regardez les autres constats pour savoir si le trafic est légitime.'],
      rules: [],
    },
  ]
}

const SEVERITY_ORDER = { high: 0, medium: 1, info: 2 } as const

/** Tous les constats, du plus important au moins important. */
export function analyzeTraffic(v: TrafficView): Finding[] {
  if (v.requests <= 0) return []
  const all = [
    ...detectLoginAbuse(v),
    ...detectXmlrpc(v),
    ...detectQueryFloods(v),
    ...detectScanners(v),
    ...detectRestApi(v),
    ...detectAjaxAbuse(v),
    ...detectIps(v),
    ...detectBots(v),
    ...detectErrors(v),
    ...detectConcentration(v),
  ]
  return all.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Textes prêts à copier
// ---------------------------------------------------------------------------------------------------------------------------------

const ACTION_LABEL: Record<RuleAction, string> = {
  managed_challenge: 'Défi géré (Managed Challenge)',
  block: 'Bloquer (Block)',
  rate_limit: 'Limitation de débit (Rate limiting)',
}

/** Règle complète, avec le chemin dans Cloudflare : ce qu'on colle dans une note ou qu'on transmet à un collègue. */
export function ruleAsText(rule: CloudflareRule): string {
  const lines = [`Nom : ${rule.name}`, `Action : ${ACTION_LABEL[rule.action]}`]
  if (rule.rateLimit) {
    lines.push(`Critère : adresse IP · ${rule.rateLimit.requests} requêtes par ${rule.rateLimit.periodSeconds} s · blocage ${rule.rateLimit.timeoutSeconds} s`)
  }
  lines.push('Expression :', rule.expression)
  lines.push(
    rule.action === 'rate_limit'
      ? 'Où : Cloudflare > votre domaine > Sécurité > WAF > Règles de limitation de débit > Créer une règle > « Modifier l’expression » > coller.'
      : 'Où : Cloudflare > votre domaine > Sécurité > WAF > Règles personnalisées > Créer une règle > « Modifier l’expression » > coller.',
  )
  if (rule.note) lines.push(`Note : ${rule.note}`)
  return lines.join('\n')
}
