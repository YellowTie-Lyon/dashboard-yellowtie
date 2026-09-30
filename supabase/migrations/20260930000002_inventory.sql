-- Phase 2 : inventaire (Server Clouds -> hébergements -> sites), credentials d'agent, audit.
--
-- Principes de sécurité :
--  * les secrets (hash de token) vivent dans une table séparée, sans aucun droit pour le client ;
--  * le client n'écrit que des colonnes explicitement autorisées (GRANT par colonne) ;
--  * tout ce qui est sensible (token, collecteur, import de sites) passe par des RPC SECURITY DEFINER
--    qui vérifient le rôle 'owner' ;
--  * workspace_id est dérivé du parent par trigger : le client ne peut pas le falsifier.

-- ---------------------------------------------------------------------------
-- Hygiène : Supabase accorde EXECUTE à anon par défaut sur les nouvelles fonctions.
-- ---------------------------------------------------------------------------
revoke all on function public.is_workspace_member(uuid) from public, anon;
revoke all on function public.has_workspace_role(uuid, public.workspace_role[]) from public, anon;
revoke all on function public.handle_first_user() from public, anon, authenticated;

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Server Clouds : porteurs des métriques système.
-- ---------------------------------------------------------------------------
create table public.cloud_servers (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces (id) on delete cascade,
  name                  text not null check (char_length(name) between 1 and 100),
  slug                  text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  provider              text not null default 'infomaniak',
  cpu_cores             integer check (cpu_cores between 1 and 512),
  hostname              text check (char_length(hostname) <= 255),   -- appris par l'agent (phase 3)
  offline_after_seconds integer not null default 240 check (offline_after_seconds between 60 and 3600),
  maintenance           boolean not null default false,
  notes                 text check (char_length(notes) <= 2000),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (workspace_id, slug)
);

create trigger cloud_servers_updated_at
  before update on public.cloud_servers
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Hébergements Web : un agent, un access.log, un token.
-- ---------------------------------------------------------------------------
create table public.web_hostings (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references public.workspaces (id) on delete cascade,
  cloud_server_id          uuid not null references public.cloud_servers (id) on delete cascade,
  name                     text not null check (char_length(name) between 1 and 100),
  technical_id             text check (char_length(technical_id) <= 100),
  system_metrics_collector boolean not null default false,
  access_log_path          text not null default '~/ik-logs/access.log' check (char_length(access_log_path) <= 255),
  probe_url                text check (probe_url is null or (probe_url ~* '^https://[^\s]+$' and char_length(probe_url) <= 500)),
  is_active                boolean not null default true,
  token_public_id          text unique,                       -- partie NON secrète du token (affichage, recherche)
  token_active             boolean not null default false,
  token_rotated_at         timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (cloud_server_id, name)
);

create index web_hostings_cloud_idx on public.web_hostings (cloud_server_id);

-- Exactement un collecteur système par Server Cloud.
create unique index web_hostings_one_collector_per_cloud
  on public.web_hostings (cloud_server_id)
  where system_metrics_collector;

create trigger web_hostings_updated_at
  before update on public.web_hostings
  for each row execute function public.set_updated_at();

-- Secrets : aucun droit pour anon/authenticated, aucune policy. Accessible uniquement aux fonctions
-- SECURITY DEFINER (rotation ici, authentification de l'agent en phase 3).
create table public.web_hosting_credentials (
  web_hosting_id        uuid primary key references public.web_hostings (id) on delete cascade,
  token_hash            bytea,
  prev_token_hash       bytea,
  prev_token_expires_at timestamptz,
  rotated_at            timestamptz
);

-- ---------------------------------------------------------------------------
-- Sites / domaines : découverts dans les logs ou saisis. Le domaine doit correspondre au vhost du log.
-- ---------------------------------------------------------------------------
create table public.sites (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  web_hosting_id uuid not null references public.web_hostings (id) on delete cascade,
  domain         text not null check (
    domain = lower(domain) and char_length(domain) <= 253
    and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$'
  ),
  source         text not null default 'manual' check (source in ('manual', 'discovered')),
  is_verified    boolean not null default true,
  is_active      boolean not null default true,
  first_seen_at  timestamptz,
  last_seen_at   timestamptz,
  created_at     timestamptz not null default now(),
  unique (web_hosting_id, domain)
);

create index sites_workspace_idx on public.sites (workspace_id);

-- ---------------------------------------------------------------------------
-- Journal d'audit (actions sensibles).
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid,
  action       text not null,
  target_type  text not null,
  target_id    uuid,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index audit_log_workspace_created_idx on public.audit_log (workspace_id, created_at desc);

create function public.write_audit(
  _workspace_id uuid, _action text, _target_type text, _target_id uuid, _details jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log (workspace_id, user_id, action, target_type, target_id, details)
  values (_workspace_id, (select auth.uid()), _action, _target_type, _target_id, coalesce(_details, '{}'::jsonb));
$$;

revoke all on function public.write_audit(uuid, text, text, uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Triggers d'intégrité multi-tenant.
-- ---------------------------------------------------------------------------
-- workspace_id dérivé du Server Cloud parent + désignation automatique du 1er collecteur.
create function public.web_hostings_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _ws uuid;
begin
  select c.workspace_id into _ws from public.cloud_servers c where c.id = new.cloud_server_id;
  if not found then
    raise exception 'cloud server not found' using errcode = '23503';
  end if;
  new.workspace_id := _ws;

  if not exists (
    select 1 from public.web_hostings h
    where h.cloud_server_id = new.cloud_server_id and h.system_metrics_collector
  ) then
    new.system_metrics_collector := true;
  end if;
  return new;
end;
$$;

revoke all on function public.web_hostings_before_insert() from public, anon, authenticated;

create trigger web_hostings_before_insert
  before insert on public.web_hostings
  for each row execute function public.web_hostings_before_insert();

-- Un hébergement ne change jamais de Server Cloud (et donc jamais de workspace).
create function public.web_hostings_lock_parent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.cloud_server_id is distinct from old.cloud_server_id
     or new.workspace_id is distinct from old.workspace_id then
    raise exception 'cloud_server_id and workspace_id are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger web_hostings_lock_parent
  before update on public.web_hostings
  for each row execute function public.web_hostings_lock_parent();

-- Journal des suppressions de Clouds / hébergements.
create function public.audit_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.write_audit(old.workspace_id, tg_table_name || '.delete', tg_table_name, old.id,
                             jsonb_build_object('name', old.name));
  return old;
end;
$$;

revoke all on function public.audit_delete() from public, anon, authenticated;

create trigger cloud_servers_audit_delete
  after delete on public.cloud_servers
  for each row execute function public.audit_delete();

create trigger web_hostings_audit_delete
  after delete on public.web_hostings
  for each row execute function public.audit_delete();

-- ---------------------------------------------------------------------------
-- RLS + GRANT par colonne.
-- ---------------------------------------------------------------------------
alter table public.cloud_servers enable row level security;
alter table public.web_hostings enable row level security;
alter table public.web_hosting_credentials enable row level security;
alter table public.sites enable row level security;
alter table public.audit_log enable row level security;

revoke all on public.cloud_servers from anon, authenticated;
revoke all on public.web_hostings from anon, authenticated;
revoke all on public.web_hosting_credentials from anon, authenticated;
revoke all on public.sites from anon, authenticated;
revoke all on public.audit_log from anon, authenticated;

-- Server Clouds
grant select on public.cloud_servers to authenticated;
grant insert (workspace_id, name, slug, cpu_cores, offline_after_seconds, maintenance, notes)
  on public.cloud_servers to authenticated;
grant update (name, slug, cpu_cores, offline_after_seconds, maintenance, notes)
  on public.cloud_servers to authenticated;
grant delete on public.cloud_servers to authenticated;

create policy cloud_servers_select on public.cloud_servers
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy cloud_servers_insert on public.cloud_servers
  for insert to authenticated
  with check (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));
create policy cloud_servers_update on public.cloud_servers
  for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));
create policy cloud_servers_delete on public.cloud_servers
  for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));

-- Hébergements (workspace_id, collecteur et token ne sont PAS écrivables par le client)
grant select on public.web_hostings to authenticated;
grant insert (cloud_server_id, name, technical_id, access_log_path, probe_url, is_active)
  on public.web_hostings to authenticated;
grant update (name, technical_id, access_log_path, probe_url, is_active)
  on public.web_hostings to authenticated;
grant delete on public.web_hostings to authenticated;

create policy web_hostings_select on public.web_hostings
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy web_hostings_insert on public.web_hostings
  for insert to authenticated
  with check (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));
create policy web_hostings_update on public.web_hostings
  for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));
create policy web_hostings_delete on public.web_hostings
  for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));

-- Sites : insertion uniquement via import_sites()
grant select on public.sites to authenticated;
grant update (is_active) on public.sites to authenticated;
grant delete on public.sites to authenticated;

create policy sites_select on public.sites
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy sites_update on public.sites
  for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));
create policy sites_delete on public.sites
  for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));

-- Audit : lecture réservée aux propriétaires, écriture uniquement par les fonctions internes.
grant select on public.audit_log to authenticated;
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));

-- ---------------------------------------------------------------------------
-- RPC : token d'agent
-- Format : ikh_<12 hex publics>_<64 hex secrets>. Seul SHA-256 du secret est stocké.
-- ---------------------------------------------------------------------------
create function public.rotate_hosting_token(_hosting_id uuid, _grace_minutes integer default 1440)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  _h         public.web_hostings;
  _grace     integer := greatest(0, least(coalesce(_grace_minutes, 0), 10080));
  _public_id text;
  _secret    text;
begin
  select * into _h from public.web_hostings where id = _hosting_id;
  if not found
     or not public.has_workspace_role(_h.workspace_id, array['owner']::public.workspace_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- L'identifiant public reste stable ; seul le secret change.
  _public_id := coalesce(_h.token_public_id, substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  _secret := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into public.web_hosting_credentials as c (web_hosting_id, token_hash, rotated_at)
  values (_hosting_id, sha256(convert_to(_secret, 'UTF8')), now())
  on conflict (web_hosting_id) do update set
    prev_token_hash       = case when _grace > 0 then c.token_hash else null end,
    prev_token_expires_at = case when _grace > 0 and c.token_hash is not null
                                 then now() + make_interval(mins => _grace) else null end,
    token_hash            = excluded.token_hash,
    rotated_at            = excluded.rotated_at;

  update public.web_hostings
     set token_public_id = _public_id, token_active = true, token_rotated_at = now()
   where id = _hosting_id;

  perform public.write_audit(_h.workspace_id, 'hosting.token_rotated', 'web_hostings', _hosting_id,
                             jsonb_build_object('grace_minutes', _grace));

  return 'ikh_' || _public_id || '_' || _secret;
end;
$$;

create function public.revoke_hosting_token(_hosting_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _h public.web_hostings;
begin
  select * into _h from public.web_hostings where id = _hosting_id;
  if not found
     or not public.has_workspace_role(_h.workspace_id, array['owner']::public.workspace_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.web_hosting_credentials
     set token_hash = null, prev_token_hash = null, prev_token_expires_at = null
   where web_hosting_id = _hosting_id;
  update public.web_hostings set token_active = false where id = _hosting_id;

  perform public.write_audit(_h.workspace_id, 'hosting.token_revoked', 'web_hostings', _hosting_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC : désignation atomique du collecteur système d'un Cloud
-- ---------------------------------------------------------------------------
create function public.set_system_collector(_hosting_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _h public.web_hostings;
begin
  select * into _h from public.web_hostings where id = _hosting_id;
  if not found
     or not public.has_workspace_role(_h.workspace_id, array['owner']::public.workspace_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not _h.is_active then
    raise exception 'hosting is inactive' using errcode = '22023';
  end if;

  update public.web_hostings
     set system_metrics_collector = false
   where cloud_server_id = _h.cloud_server_id and system_metrics_collector and id <> _hosting_id;
  update public.web_hostings set system_metrics_collector = true where id = _hosting_id;

  perform public.write_audit(_h.workspace_id, 'cloud.collector_changed', 'web_hostings', _hosting_id,
                             jsonb_build_object('cloud_server_id', _h.cloud_server_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC : import en masse de domaines (un par ligne, avec ou sans schéma / chemin / port)
-- Les domaines sont conservés tels quels (www. inclus) : ils doivent correspondre au vhost des logs.
-- ---------------------------------------------------------------------------
create function public.import_sites(_hosting_id uuid, _domains text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _h        public.web_hostings;
  _raw      text;
  _d        text;
  _inserted integer := 0;
  _existing integer := 0;
  _invalid  jsonb := '[]'::jsonb;
  _seen     text[] := '{}';
  _n        integer;
begin
  select * into _h from public.web_hostings where id = _hosting_id;
  if not found
     or not public.has_workspace_role(_h.workspace_id, array['owner']::public.workspace_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(array_length(_domains, 1), 0) > 500 then
    raise exception 'too many domains (max 500 per import)' using errcode = '22023';
  end if;

  foreach _raw in array coalesce(_domains, '{}') loop
    _d := lower(btrim(_raw));
    if _d = '' then
      continue;
    end if;
    _d := regexp_replace(_d, '^[a-z][a-z0-9+.-]*://', '');
    _d := regexp_replace(_d, '[/?#].*$', '');
    _d := regexp_replace(_d, ':[0-9]+$', '');
    _d := regexp_replace(_d, '\.$', '');

    if char_length(_d) > 253
       or _d !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$' then
      if jsonb_array_length(_invalid) < 50 then
        _invalid := _invalid || to_jsonb(left(_raw, 100));
      end if;
      continue;
    end if;

    if _d = any (_seen) then
      continue;   -- doublon dans la liste collée
    end if;
    _seen := _seen || _d;

    insert into public.sites (workspace_id, web_hosting_id, domain, source)
    values (_h.workspace_id, _hosting_id, _d, 'manual')
    on conflict (web_hosting_id, domain) do nothing;
    get diagnostics _n = row_count;
    if _n = 1 then _inserted := _inserted + 1; else _existing := _existing + 1; end if;
  end loop;

  perform public.write_audit(_h.workspace_id, 'hosting.sites_imported', 'web_hostings', _hosting_id,
                             jsonb_build_object('inserted', _inserted, 'existing', _existing,
                                                'invalid', jsonb_array_length(_invalid)));

  return jsonb_build_object('inserted', _inserted, 'existing', _existing, 'invalid', _invalid);
end;
$$;

revoke all on function public.rotate_hosting_token(uuid, integer) from public, anon;
revoke all on function public.revoke_hosting_token(uuid) from public, anon;
revoke all on function public.set_system_collector(uuid) from public, anon;
revoke all on function public.import_sites(uuid, text[]) from public, anon;
grant execute on function public.rotate_hosting_token(uuid, integer) to authenticated;
grant execute on function public.revoke_hosting_token(uuid) to authenticated;
grant execute on function public.set_system_collector(uuid) to authenticated;
grant execute on function public.import_sites(uuid, text[]) to authenticated;
