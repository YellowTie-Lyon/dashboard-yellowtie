import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/** Vrai si les deux variables publiques du frontend sont renseignées. */
export const isSupabaseConfigured = Boolean(url && anonKey)

// Clé publique par conception : l'accès aux données est protégé par la RLS et la session utilisateur.
// Aucun secret (service_role, token d'agent, webhook Discord) ne doit jamais atteindre ce fichier.
const client: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      })
    : null

export function getSupabase(): SupabaseClient {
  if (!client) {
    throw new Error('Supabase non configuré (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY manquants).')
  }
  return client
}
