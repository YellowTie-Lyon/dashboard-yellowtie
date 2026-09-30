import { analyzeTraffic, ruleAsText, type Finding } from './trafficAnalysis'
import type { TrafficView } from './trafficView'

/** Contexte facultatif (incident) ajouté en tête du rapport. */
export interface ReportContext {
  incident?: { cloud: string; kind: string; severity: string; startedAt: string; endedAt: string | null; peaks: string[] }
}

const fmtN = (n: number) => n.toLocaleString('fr-FR')
const pct = (part: number, total: number) => (total > 0 ? `${Math.round((100 * part) / total)} %` : '0 %')

/**
 * Rapport prêt à coller dans ChatGPT : uniquement des agrégats (aucune ligne de log brute), les constats automatiques
 * préliminaires, puis une consigne demandant des règles Cloudflare prudentes (pas seulement WooCommerce).
 */
export function buildChatGptReport(v: TrafficView, ctx: ReportContext = {}, findings: Finding[] = analyzeTraffic(v)): string {
  const out: string[] = []
  out.push('# Rapport de trafic YellowScope', '')
  out.push(`Périmètre : ${v.scope}`, `Période : ${v.periodLabel} (${v.minutes} min)`, `Requêtes analysées : ${fmtN(v.requests)}${v.sampled ? ' (échantillon)' : ''}`)
  if (v.totals) {
    out.push(`Erreurs 4xx : ${fmtN(v.totals.r4xx)} · erreurs 5xx : ${fmtN(v.totals.r5xx)} · POST : ${fmtN(v.totals.posts)} (${pct(v.totals.posts, v.requests)}) · robots : ${fmtN(v.totals.bots)} (${pct(v.totals.bots, v.requests)})`)
  }
  if (ctx.incident) {
    const i = ctx.incident
    out.push('', '## Incident', `Serveur Cloud : ${i.cloud}`, `Type : ${i.kind} · gravité max : ${i.severity}`, `Début : ${i.startedAt}${i.endedAt ? ` · fin : ${i.endedAt}` : ' · en cours'}`)
    if (i.peaks.length) out.push(`Valeurs maximales : ${i.peaks.join(' · ')}`)
  }
  if (v.hostings.length) {
    out.push('', '## Hébergements les plus sollicités')
    for (const h of v.hostings.slice(0, 6)) out.push(`- ${h.name} : ${fmtN(h.requests)} requêtes (${Math.round(h.share)} %)`)
  }
  if (v.domains.length) {
    out.push('', '## Domaines les plus sollicités')
    for (const d of v.domains.slice(0, 10)) {
      const extra = [d.hosting, d.r4xx ? `${fmtN(d.r4xx)} en 4xx` : '', d.r5xx ? `${fmtN(d.r5xx)} en 5xx` : '', d.posts ? `${fmtN(d.posts)} POST` : '', d.bots ? `${fmtN(d.bots)} robots` : ''].filter(Boolean)
      out.push(`- ${d.domain} : ${fmtN(d.requests)} requêtes${extra.length ? ` (${extra.join(', ')})` : ''}`)
    }
  }
  if (v.paths.length) {
    out.push('', '## URL les plus demandées')
    for (const p of v.paths.slice(0, 15)) out.push(`- ${p.domain}${p.path} : ${fmtN(p.requests)}${p.errors ? `, ${fmtN(p.errors)} erreurs` : ''}${p.posts ? `, ${fmtN(p.posts)} POST` : ''}`)
  }
  if (v.queries.length) {
    out.push('', '## Motifs de paramètres d’URL (valeurs masquées)')
    for (const q of v.queries.slice(0, 10)) out.push(`- ${q.domain} ?${q.query} : ${fmtN(q.requests)}${q.errors ? `, ${fmtN(q.errors)} erreurs` : ''}`)
  }
  if (v.ips.length) {
    out.push('', '## Adresses IP les plus actives')
    for (const i of v.ips.slice(0, 10)) out.push(`- ${i.ip} : ${fmtN(i.requests)}`)
  }
  if (v.ipdomains.length) {
    out.push('', '## IP par domaine')
    for (const i of v.ipdomains.slice(0, 10)) out.push(`- ${i.ip} → ${i.domain} : ${fmtN(i.requests)}`)
  }
  if (v.uas.length) {
    out.push('', '## User-agents les plus fréquents')
    for (const u of v.uas.slice(0, 8)) out.push(`- ${u.ua} : ${fmtN(u.requests)}`)
  }
  if (v.agents) out.push('', `## Visiteurs`, `Googlebot ${fmtN(v.agents.googlebot)} · autres robots ${fmtN(v.agents.bots)} · navigateurs ${fmtN(v.agents.browsers)} · sans user-agent ${fmtN(v.agents.empty)}`)
  if (findings.length) {
    out.push('', '## Constats automatiques préliminaires (à confirmer)')
    for (const f of findings.slice(0, 8)) out.push(`- [${f.severity}] ${f.title} : ${f.evidence}`)
  }
  out.push(
    '',
    '## Ta mission',
    'Tu es un expert WordPress et Cloudflare. Ces chiffres sont des agrégats issus de l’access.log de mes hébergements mutualisés (plusieurs sites WordPress, pas uniquement WooCommerce).',
    '1. Identifie le ou les sites et le motif probablement responsable de la surcharge (login, xmlrpc, recherche, filtres, REST, admin-ajax, scanners, robots, IP…), en distinguant ce qui est établi de ce qui est une hypothèse.',
    '2. Propose des règles Cloudflare (règles personnalisées ou limitation de débit) avec l’expression exacte, l’action (défi géré de préférence au blocage) et où la créer.',
    '3. Précise mon offre Cloudflare supposée (Free/Pro), les risques de faux positifs (clients connectés, API, paiement, robots légitimes) et comment vérifier avant d’activer.',
    '4. Si les données sont insuffisantes, dis-moi quelles informations supplémentaires te fournir.',
  )
  return out.join('\n')
}

/** Toutes les règles suggérées, en un seul texte. */
export function buildRulesText(findings: Finding[]): string {
  return findings.flatMap((f) => f.rules.map((r) => `# ${f.title}\n${ruleAsText(r)}`)).join('\n\n')
}
