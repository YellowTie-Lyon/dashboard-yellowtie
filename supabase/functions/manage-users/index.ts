// Fonction Edge « manage-users » : invitation, suppression et réinitialisation du double facteur d'un utilisateur.
//
// Sécurité :
//  * l'appelant doit être connecté (JWT vérifié par Supabase) ET prouver qu'il est PROPRIÉTAIRE en session aal2 :
//    la preuve est l'appel de list_workspace_members(), qui refuse toute autre session (42501) ;
//  * la clé de service (SUPABASE_SERVICE_ROLE_KEY, fournie par Supabase à l'exécution, jamais dans le dépôt) n'est utilisée
//    qu'après cette vérification, et seulement pour les trois actions ci-dessous ;
//  * chaque action est validée strictement (logic.ts) et journalisée (record_user_event).
import { createClient } from 'npm:@supabase/supabase-js@2'
import { checkInvite, checkTarget, inviteErrorMessage, parseRequest, siteOrigin, type Member } from './logic.ts'

const corsHeaders = (origin: string | null) => ({
  'Access-Control-Allow-Origin': origin ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
})

const json = (body: unknown, status = 200, origin: string | null = null) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } })

Deno.serve(async (req) => {
  const origin = siteOrigin(req.headers.get('origin'), Deno.env.get('SITE_URL'))
  // Pré-requête CORS du navigateur : une réponse 204 ne doit JAMAIS porter de corps (sinon le constructeur Response échoue).
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) })
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée.' }, 405, origin)

  const url = Deno.env.get('SUPABASE_URL')!
  const authorization = req.headers.get('Authorization') ?? ''
  const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authorization } } })

  const { data: userData, error: userError } = await userClient.auth.getUser()
  if (userError || !userData.user) return json({ error: 'Non authentifié.' }, 401, origin)
  const actorId = userData.user.id

  // Preuve « propriétaire + aal2 » et liste des membres : refusées par la base pour toute autre session.
  const { data: rows, error: forbidden } = await userClient.rpc('list_workspace_members')
  if (forbidden) return json({ error: 'Réservé aux propriétaires (double authentification validée).' }, 403, origin)
  const members = (rows ?? []) as (Member & { mfa_enabled: boolean })[]
  const workspaceId = members[0]?.workspace_id
  if (!workspaceId) return json({ error: 'Workspace introuvable.' }, 403, origin)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Requête invalide.' }, 400, origin)
  }
  const parsed = parseRequest(body)
  if (!parsed.ok) return json({ error: parsed.error }, 400, origin)
  const cmd = parsed.value

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
  const log = (action: string, target: string | null, details: Record<string, unknown>) =>
    admin.rpc('record_user_event', { _workspace_id: workspaceId, _actor: actorId, _action: action, _target: target, _details: details })

  if (cmd.action === 'invite' || cmd.action === 'create') {
    const check = checkInvite(members, cmd.email)
    if (!check.ok) return json({ error: check.error }, check.status, origin)

    let created: { id: string } | null = null
    if (cmd.action === 'invite') {
      if (!origin) return json({ error: "Origine de la requête invalide (HTTPS requis)." }, 400, origin)
      const { data, error } = await admin.auth.admin.inviteUserByEmail(cmd.email, { redirectTo: `${origin}/bienvenue` })
      if (error || !data.user) {
        const m = inviteErrorMessage(error as { code?: string; message?: string } | null)
        return json({ error: m.error }, m.status, origin)
      }
      created = data.user
    } else {
      // Création directe : compte confirmé d'emblée (aucun e-mail), mot de passe choisi par le propriétaire.
      const { data, error } = await admin.auth.admin.createUser({ email: cmd.email, password: cmd.password, email_confirm: true })
      if (error || !data.user) {
        const m = inviteErrorMessage(error as { code?: string; message?: string } | null)
        return json({ error: m.error }, m.status, origin)
      }
      created = data.user
    }

    const { error: memberError } = await admin.from('workspace_members').insert({ workspace_id: workspaceId, user_id: created.id, role: cmd.role })
    if (memberError) {
      // Aucun compte orphelin : si le rattachement échoue, le compte tout juste créé est supprimé.
      await admin.auth.admin.deleteUser(created.id)
      return json({ error: "Création annulée : rattachement au workspace impossible. Réessayez." }, 500, origin)
    }
    await log(cmd.action === 'invite' ? 'user.invited' : 'user.created', created.id, { email: cmd.email, role: cmd.role })
    return json({ ok: true }, 200, origin)
  }

  const check = checkTarget(cmd.action, members, cmd.userId)
  if (!check.ok) return json({ error: check.error }, check.status, origin)
  const target = members.find((m) => m.user_id === cmd.userId)!

  if (cmd.action === 'remove') {
    const { error } = await admin.auth.admin.deleteUser(cmd.userId)
    if (error) return json({ error: 'Suppression impossible.' }, 500, origin)
    await log('user.removed', cmd.userId, { email: target.email })
    return json({ ok: true }, 200, origin)
  }

  // reset_mfa : supprime tous les facteurs ; l'utilisateur devra en enrôler un nouveau à sa prochaine connexion.
  const { data: factors, error: listError } = await admin.auth.admin.mfa.listFactors({ userId: cmd.userId })
  if (listError) return json({ error: 'Réinitialisation impossible.' }, 500, origin)
  for (const f of factors?.factors ?? []) {
    const { error } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: cmd.userId })
    if (error) return json({ error: 'Réinitialisation impossible.' }, 500, origin)
  }
  await log('user.mfa_reset', cmd.userId, { email: target.email })
  return json({ ok: true }, 200, origin)
})
