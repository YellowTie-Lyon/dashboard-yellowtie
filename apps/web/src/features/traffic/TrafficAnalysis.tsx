import { useMemo } from 'react'
import { btn, btnPrimary, card, labelMono, mutedText } from '../../components/ui'
import { analyzeTraffic, ruleAsText, type Finding, type RuleAction } from '../../lib/trafficAnalysis'
import { buildChatGptReport, buildRulesText, type ReportContext } from '../../lib/trafficReport'
import type { TrafficView } from '../../lib/trafficView'
import { useCopy } from '../../lib/useCopy'

const SEVERITY: Record<Finding['severity'], { label: string; cls: string }> = {
  high: { label: 'À traiter', cls: 'border-red-500/40 text-red-400' },
  medium: { label: 'À surveiller', cls: 'border-orange-400/40 text-orange-400' },
  info: { label: 'Information', cls: 'border-white/20 text-slate-400' },
}
const ACTION: Record<RuleAction, string> = { managed_challenge: 'Défi géré', block: 'Blocage', rate_limit: 'Limitation de débit' }

/**
 * Bouton « Copier le rapport pour ChatGPT » + constats automatiques et règles Cloudflare suggérées.
 * Rien n'est appliqué par YellowScope : les règles sont à copier et à vérifier dans Cloudflare.
 */
export function TrafficAnalysis({ view, context }: { view: TrafficView; context?: ReportContext }) {
  const findings = useMemo(() => analyzeTraffic(view), [view])
  const { copied, failed, copy } = useCopy()
  if (view.requests <= 0) return null

  return (
    <section className={card} aria-label="Analyse et règles Cloudflare">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className={labelMono}>Analyse automatique</p>
          <h2 className="text-lg font-semibold">Motifs détectés et règles Cloudflare suggérées</h2>
        </div>
        <button type="button" className={btnPrimary} onClick={() => void copy('report', buildChatGptReport(view, context, findings))}>
          {copied === 'report' ? 'Rapport copié ✓' : 'Copier le rapport pour ChatGPT'}
        </button>
      </div>
      {failed && <p role="alert" className="mt-2 text-sm text-red-400">Copie impossible : autorisez le presse-papiers ou sélectionnez le texte à la main.</p>}
      {!view.detailed && (
        <p className={`mt-2 ${mutedText}`}>Détail limité : mettez l'agent à jour (0.4.0) pour détecter aussi les motifs de paramètres et les user-agents.</p>
      )}

      {findings.length === 0 ? (
        <p className={`mt-3 ${mutedText}`}>Aucun motif anormal détecté dans ces données. Le rapport ChatGPT reste utilisable pour une analyse plus fine.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {findings.map((f) => (
            <li key={f.id} className="rounded-xl border border-white/10 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY[f.severity].cls}`}>{SEVERITY[f.severity].label}</span>
                <h3 className="font-semibold">{f.title}</h3>
              </div>
              <p className="mt-1 text-sm">{f.evidence}</p>
              {f.cautions.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-slate-400">
                  {f.cautions.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
              {f.rules.map((r, idx) => (
                <div key={`${f.id}-${idx}`} className="mt-3 rounded-lg bg-black/30 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {r.name} <span className="text-xs text-slate-500">· {ACTION[r.action]}</span>
                    </p>
                    <div className="flex gap-1.5">
                      <button type="button" className={btn} onClick={() => void copy(`e-${f.id}-${idx}`, r.expression)}>
                        {copied === `e-${f.id}-${idx}` ? 'Copié ✓' : "Copier l'expression"}
                      </button>
                      <button type="button" className={btn} onClick={() => void copy(`r-${f.id}-${idx}`, ruleAsText(r))}>
                        {copied === `r-${f.id}-${idx}` ? 'Copié ✓' : 'Copier la règle complète'}
                      </button>
                    </div>
                  </div>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-slate-300">{r.expression}</pre>
                  {r.rateLimit && (
                    <p className="mt-1 text-xs text-slate-500">
                      {r.rateLimit.requests} requêtes / {r.rateLimit.periodSeconds} s par IP, blocage {r.rateLimit.timeoutSeconds} s.
                    </p>
                  )}
                  {r.note && <p className="mt-1 text-xs text-slate-500">{r.note}</p>}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
      {findings.some((f) => f.rules.length > 0) && (
        <div className="mt-3">
          <button type="button" className={btn} onClick={() => void copy('all', buildRulesText(findings))}>
            {copied === 'all' ? 'Règles copiées ✓' : 'Copier toutes les règles'}
          </button>
        </div>
      )}
      <p className={`mt-4 text-xs ${mutedText}`}>
        Suggestions à valider : YellowScope n'applique rien dans Cloudflare. Testez d'abord en mode « Journaliser » si possible ; un gros volume n'est pas une preuve d'attaque.
      </p>
    </section>
  )
}
