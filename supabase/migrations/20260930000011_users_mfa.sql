-- Phase 9 : gestion des utilisateurs et double authentification (TOTP).
--
-- 1. La base EXIGE une session « aal2 » (mot de passe + code TOTP validé) pour toute lecture ou écriture protégée par la RLS :
--    même avec un mot de passe volé, un attaquant sans le code de l'application d'authentification ne lit rien.
-- 2. Lecture et changement de rôle des membres du workspace (propriétaires seulement). L'invitation, la suppression d'un
--    compte et la réinitialisation du double facteur passent par la fonction Edge « manage-users » (clé de service côté serveur).

-- ---------------------------------------------------------------------------
-- Niveau d'assurance de la session (claim « aal » du JWT)
-- ---------------------------------------------------------------------------
create function public.is_aal2()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2';
$$;
revoke all on function public.is_aal2() from public;
grant execute on function public.is_aal2() to anon, authenticated;

-- Les deux fonctions d'appartenance (utilisées par TOUTES les politiques RLS) exigent désormais aal2.
create or replace function public.is_workspace_member(_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_aal2() and exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = _workspace_id
      and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.has_workspace_role(_workspace_id uuid, _roles public.workspace_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_aal2() and exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = _workspace_id
      and m.user_id = (select auth.uid())
      and m.role = any (_roles)
  );
$$;

-- Statistiques de stockage : même exigence.
create or replace function public.get_storage_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_aal2()
     or not exists (select 1 from public.workspace_members where user_id = auth.uid()) then
    return null;
  end if;
  return jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'tables', coalesce((
      select jsonb_agg(t order by (t ->> 'bytes')::bigint desc) from (
        select jsonb_build_object('name', c.relname, 'bytes', pg_total_relation_size(c.oid), 'rows', greatest(c.reltuples, 0)::bigint) t
          from pg_class c
         where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
         order by pg_total_relation_size(c.oid) desc
         limit 10
      ) q), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Membres du workspace (propriétaires, session aal2)
-- ---------------------------------------------------------------------------
create function public.list_workspace_members()
returns table (
  workspace_id uuid, user_id uuid, email text, role public.workspace_role,
  joined_at timestamptz, last_sign_in_at timestamptz, mfa_enabled boolean, is_self boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _ws uuid;
begin
  select m.workspace_id into _ws from public.workspace_members m
   where m.user_id = auth.uid() and m.role = 'owner' limit 1;
  if _ws is null or not public.is_aal2() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select m.workspace_id, m.user_id, u.email::text, m.role, m.created_at, u.last_sign_in_at,
           exists (select 1 from auth.mfa_factors f where f.user_id = m.user_id and f.status = 'verified'),
           m.user_id = auth.uid()
      from public.workspace_members m
      join auth.users u on u.id = m.user_id
     where m.workspace_id = _ws
     order by m.created_at, u.email;
end;
$$;
revoke all on function public.list_workspace_members() from public, anon;
grant execute on function public.list_workspace_members() to authenticated;

create function public.set_member_role(_user_id uuid, _role public.workspace_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _ws uuid;
  _current public.workspace_role;
begin
  select m.workspace_id into _ws from public.workspace_members m
   where m.user_id = auth.uid() and m.role = 'owner' limit 1;
  if _ws is null or not public.is_aal2() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select role into _current from public.workspace_members where workspace_id = _ws and user_id = _user_id;
  if not found then
    raise exception 'unknown member' using errcode = 'P0002';
  end if;
  if _current = 'owner' and _role <> 'owner'
     and (select count(*) from public.workspace_members where workspace_id = _ws and role = 'owner') <= 1 then
    raise exception 'last owner' using errcode = '23514';
  end if;
  update public.workspace_members set role = _role where workspace_id = _ws and user_id = _user_id;
  perform public.write_audit(_ws, 'member.role_changed', 'workspace_members', _user_id,
                             jsonb_build_object('from', _current, 'to', _role));
end;
$$;
revoke all on function public.set_member_role(uuid, public.workspace_role) from public, anon;
grant execute on function public.set_member_role(uuid, public.workspace_role) to authenticated;

-- Journal des actions faites par la fonction Edge (appelée avec la clé de service uniquement).
create function public.record_user_event(_workspace_id uuid, _actor uuid, _action text, _target uuid, _details jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log (workspace_id, user_id, action, target_type, target_id, details)
  values (_workspace_id, _actor, _action, 'user', _target, coalesce(_details, '{}'::jsonb));
$$;
revoke all on function public.record_user_event(uuid, uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_user_event(uuid, uuid, text, uuid, jsonb) to service_role;
