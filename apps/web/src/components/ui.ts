// Classes Tailwind partagées (boutons, champs) pour garder une interface homogène.
export const btn =
  'inline-flex items-center justify-center gap-1.5 rounded-full border border-white/15 bg-transparent px-4 py-1.5 text-sm font-medium text-slate-100 transition-colors hover:border-white/30 hover:bg-white/10 disabled:opacity-50'
export const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 rounded-full bg-brand px-4 py-1.5 text-sm font-semibold text-slate-950 shadow-[0_0_24px_-6px_rgb(255_198_41/0.7)] transition hover:brightness-110 disabled:opacity-50 disabled:shadow-none'
export const btnDanger =
  'inline-flex items-center justify-center gap-1.5 rounded-full border border-red-500/40 bg-transparent px-4 py-1.5 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50'
export const input =
  'mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-yellow-500 focus:ring-2 focus:ring-yellow-400/40 dark:border-slate-700 dark:bg-slate-900'
export const card =
  'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/[0.03] dark:shadow-none'
/** Étiquette en petites capitales monospace (repère visuel de la charte). */
export const labelMono = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400'
export const mutedText = 'text-sm text-slate-500 dark:text-slate-400'
