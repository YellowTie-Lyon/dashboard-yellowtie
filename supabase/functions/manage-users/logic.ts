// Logique pure de la fonction « manage-users » (sans dépendance Deno : testable avec Node).

export type Role = 'owner' | 'viewer'

export interface Member {
  workspace_id: string
  user_id: string
  email: string
  role: string
  is_self: boolean
}

export type Action =
  | { action: 'invite'; email: string; role: Role }
  | { action: 'remove'; userId: string }
  | { action: 'reset_mfa'; userId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/

export type Parsed = { ok: true; value: Action } | { ok: false; error: string }

/** Valide strictement le corps de la requête : action connue, e-mail plausible, rôle autorisé, identifiant UUID. */
export function parseRequest(body: unknown): Parsed {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'Requête invalide.' }
  const b = body as Record<string, unknown>
  if (b.action === 'invite') {
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
    if (!EMAIL.test(email) || email.length > 254) return { ok: false, error: 'Adresse e-mail invalide.' }
    if (b.role !== 'owner' && b.role !== 'viewer') return { ok: false, error: 'Rôle invalide.' }
    return { ok: true, value: { action: 'invite', email, role: b.role } }
  }
  if (b.action === 'remove' || b.action === 'reset_mfa') {
    if (typeof b.userId !== 'string' || !UUID.test(b.userId)) return { ok: false, error: 'Utilisateur invalide.' }
    return { ok: true, value: { action: b.action, userId: b.userId } }
  }
  return { ok: false, error: 'Action inconnue.' }
}

export type Check = { ok: true } | { ok: false; status: number; error: string }

/** Règles de sécurité communes à la suppression et à la réinitialisation du double facteur. */
export function checkTarget(action: 'remove' | 'reset_mfa', members: Member[], targetId: string): Check {
  const target = members.find((m) => m.user_id === targetId)
  if (!target) return { ok: false, status: 404, error: 'Utilisateur introuvable dans ce workspace.' }
  if (target.is_self) {
    return {
      ok: false,
      status: 400,
      error: action === 'remove' ? 'Vous ne pouvez pas supprimer votre propre compte.' : 'Réinitialisez votre double facteur depuis « Mon compte ».',
    }
  }
  if (action === 'remove' && target.role === 'owner' && members.filter((m) => m.role === 'owner').length <= 1) {
    return { ok: false, status: 400, error: 'Impossible de supprimer le dernier propriétaire.' }
  }
  return { ok: true }
}

export function checkInvite(members: Member[], email: string): Check {
  if (members.some((m) => m.email.toLowerCase() === email)) {
    return { ok: false, status: 409, error: 'Cet utilisateur fait déjà partie du workspace.' }
  }
  return { ok: true }
}

/** Origine autorisée pour le lien d'invitation : HTTPS uniquement (ou localhost en développement). */
export function siteOrigin(origin: string | null, fallback: string | undefined): string | null {
  const candidate = origin ?? fallback ?? null
  if (!candidate) return null
  try {
    const u = new URL(candidate)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null
    return u.origin
  } catch {
    return null
  }
}

/** Traduit une erreur de l'API d'administration Supabase (invitation) en message utile à l'utilisateur. */
export function inviteErrorMessage(error: { code?: string; message?: string } | null): { status: number; error: string } {
  switch (error?.code) {
    case 'email_exists':
    case 'user_already_exists':
      return {
        status: 409,
        error:
          "Ce compte existe déjà dans Supabase sans être rattaché au workspace (invitation précédente incomplète). Supprimez-le dans Supabase > Authentication > Users, puis relancez l'invitation.",
      }
    case 'over_email_send_rate_limit':
      return { status: 429, error: "Trop d'e-mails envoyés récemment (limite de Supabase). Patientez une heure ou configurez un serveur SMTP." }
    case 'email_address_invalid':
    case 'email_address_not_authorized':
      return { status: 400, error: "Cette adresse e-mail est refusée par Supabase (adresse invalide ou non autorisée par le serveur d'envoi)." }
    default:
      return { status: 400, error: `Invitation impossible${error?.message ? ` : ${error.message}` : '.'}` }
  }
}
