/**
 * Commande d'installation / de mise à jour de l'agent. Le token n'y figure JAMAIS : l'installeur le demande en saisie
 * masquée (installation) ou conserve celui déjà présent sur l'hébergement (mise à jour : Entrée).
 */
export function agentInstallCommand(): string {
  const siteUrl = window.location.origin
  const apiUrl = import.meta.env.VITE_SUPABASE_URL ?? 'https://<projet>.supabase.co'
  const apiKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '<clé publique>'
  return [
    `curl -fsSL ${siteUrl}/agent/install.sh -o ik-install.sh`,
    `bash ik-install.sh --base-url ${siteUrl} --api-url ${apiUrl} --api-key ${apiKey}`,
  ].join('\n')
}
