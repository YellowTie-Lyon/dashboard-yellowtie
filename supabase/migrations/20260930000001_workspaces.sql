-- Phase 1 : tenancy (workspaces) + RLS de base.
-- Un seul utilisateur au MVP, mais le modèle multi-utilisateur est en place dès maintenant
-- pour ne pas avoir à réécrire toute la RLS plus tard.

create type public.workspace_role as enum ('owner', 'admin', 'viewer');

create table public.workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 100),
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         public.workspace_role not null default 'viewer',
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_idx on public.workspace_members (user_id);

-- ---------------------------------------------------------------------------
-- Fonctions d'appartenance utilisées par la RLS de toutes les tables suivantes.
-- SECURITY DEFINER : évite la récursion de RLS sur workspace_members.
-- search_path vide : toutes les références sont qualifiées.
-- ---------------------------------------------------------------------------
create function public.is_workspace_member(_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = _workspace_id
      and m.user_id = (select auth.uid())
  );
$$;

create function public.has_workspace_role(_workspace_id uuid, _roles public.workspace_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = _workspace_id
      and m.user_id = (select auth.uid())
      and m.role = any (_roles)
  );
$$;

revoke all on function public.is_workspace_member(uuid) from public;
revoke all on function public.has_workspace_role(uuid, public.workspace_role[]) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid, public.workspace_role[]) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS : lecture seule pour les membres. Aucune écriture depuis le client :
-- les modifications passeront par des RPC SECURITY DEFINER (phases suivantes).
-- ---------------------------------------------------------------------------
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;

-- Supabase accorde par défaut tous les droits à anon/authenticated sur les nouvelles tables.
revoke all on public.workspaces from anon, authenticated;
revoke all on public.workspace_members from anon, authenticated;
grant select on public.workspaces to authenticated;
grant select on public.workspace_members to authenticated;

create policy workspaces_select_member
  on public.workspaces
  for select
  to authenticated
  using (public.is_workspace_member(id));

create policy workspace_members_select_same_workspace
  on public.workspace_members
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Amorçage : l'inscription publique est désactivée, les comptes sont créés par
-- l'administrateur. Le tout premier utilisateur crée le workspace et en devient
-- propriétaire. Les suivants ne sont PAS rattachés automatiquement (voir docs/setup.md).
-- ---------------------------------------------------------------------------
create function public.handle_first_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _workspace_id uuid;
begin
  if not exists (select 1 from public.workspaces) then
    insert into public.workspaces (name) values ('YellowTie') returning id into _workspace_id;
    insert into public.workspace_members (workspace_id, user_id, role)
    values (_workspace_id, new.id, 'owner');
  end if;
  return new;
end;
$$;

revoke all on function public.handle_first_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_first_user();
