-- Phase 3 : réception des heartbeats et des métriques système des agents.
--
-- Les agents appellent POST /rest/v1/rpc/agent_heartbeat (PostgREST) avec :
--   apikey: <clé publique>              (exigée par la passerelle Supabase, non secrète)
--   x-agent-token: ikh_<id>_<secret>    (identité de l'agent)
--   Prefer: params=single-object        (le corps JSON est le paramètre _payload)
-- L'identité (hébergement, Cloud, workspace) est dérivée EXCLUSIVEMENT du token authentifié.

-- ---------------------------------------------------------------------------
-- Métriques système brutes : 1 ligne / minute / Server Cloud
-- ---------------------------------------------------------------------------
create table public.metrics (
  cloud_server_id         uuid        not null references public.cloud_servers (id) on delete cascade,
  ts                      timestamptz not null,
  collected_by_hosting_id uuid        references public.web_hostings (id) on delete set null,
  received_at             timestamptz not null default now(),
  cpu_cores               smallint    not null check (cpu_cores between 1 and 512),
  load1                   real        not null check (load1 >= 0),
  load5                   real        not null check (load5 >= 0),
  load15                  real        not null check (load15 >= 0),
  load1_per_core          real        not null,
  load5_per_core          real        not null,
  cpu_pct                 real        check (cpu_pct between 0 and 100),   -- null = non calculable (1er relevé, redémarrage)
  mem_total_mb            integer     not null check (mem_total_mb > 0),
  mem_used_mb             integer     not null check (mem_used_mb >= 0),
  mem_avail_mb            integer     not null check (mem_avail_mb >= 0),
  mem_used_pct            real        not null check (mem_used_pct between 0 and 100),
  swap_total_mb           integer     not null check (swap_total_mb >= 0),
  swap_used_mb            integer     not null check (swap_used_mb >= 0),
  swap_used_pct           real        not null check (swap_used_pct between 0 and 100),
  disk_total_mb           integer     not null check (disk_total_mb > 0),
  disk_used_mb            integer     not null check (disk_used_mb >= 0),
  disk_avail_mb           integer     not null check (disk_avail_mb >= 0),
  disk_used_pct           real        not null check (disk_used_pct between 0 and 100),
  uptime_s                bigint      not null check (uptime_s >= 0),
  extra                   jsonb       not null default '{}'::jsonb,        -- futures métriques sans migration
  primary key (cloud_server_id, ts)
);

create index metrics_ts_idx on public.metrics (ts);   -- purge par ancienneté (phase 4)

-- ---------------------------------------------------------------------------
-- État « chaud » : une ligne par Cloud / par hébergement, mise à jour à chaque heartbeat
-- ---------------------------------------------------------------------------
create table public.cloud_server_state (
  cloud_server_id  uuid primary key references public.cloud_servers (id) on delete cascade,
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  last_metrics_at  timestamptz not null,   -- horodatage du dernier relevé reçu (heure de l'agent)
  last_received_at timestamptz not null,   -- heure de réception côté serveur
  last_point       jsonb not null,
  updated_at       timestamptz not null default now()
);

create table public.web_hosting_state (
  web_hosting_id  uuid primary key references public.web_hostings (id) on delete cascade,
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  last_seen_at    timestamptz not null,
  agent_version   text,
  hostname_seen   text,
  backlog         integer,
  last_error      text,
  log_size_bytes  bigint,
  log_inode       bigint,
  anomaly         text,                    -- ex. hostname_mismatch, points_ignored
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS : lecture par les membres, aucune écriture depuis le client
-- ---------------------------------------------------------------------------
alter table public.metrics enable row level security;
alter table public.cloud_server_state enable row level security;
alter table public.web_hosting_state enable row level security;

revoke all on public.metrics from anon, authenticated;
revoke all on public.cloud_server_state from anon, authenticated;
revoke all on public.web_hosting_state from anon, authenticated;
grant select on public.metrics to authenticated;
grant select on public.cloud_server_state to authenticated;
grant select on public.web_hosting_state to authenticated;

-- Le sous-select sur cloud_servers est lui-même filtré par la RLS de l'appelant.
create policy metrics_select on public.metrics
  for select to authenticated
  using (exists (select 1 from public.cloud_servers c where c.id = metrics.cloud_server_id));
create policy cloud_server_state_select on public.cloud_server_state
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy web_hosting_state_select on public.web_hosting_state
  for select to authenticated using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- agent_heartbeat : authentification, validation stricte, rate limit, ingestion
-- Codes HTTP (via SQLSTATE PTxxx) : 400 payload invalide, 401 token, 403 hébergement inactif, 429 trop fréquent.
-- Les points invalides sont IGNORÉS (comptés dans « rejected ») pour qu'un point corrompu en spool ne
-- bloque jamais les suivants.
-- ---------------------------------------------------------------------------
create function public.agent_heartbeat(_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _headers    jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  _token      text  := _headers ->> 'x-agent-token';
  _now        timestamptz := now();
  _h          public.web_hostings;
  _cred       public.web_hosting_credentials;
  _state      public.web_hosting_state;
  _hash       bytea;
  _agent      jsonb;
  _version    text;
  _hostname   text;
  _backlog    integer;
  _last_error text;
  _log_size   bigint;
  _log_inode  bigint;
  _points     jsonb;
  _p          jsonb;
  _anomaly    text;
  _cloud_host text;
  _accepted   integer := 0;
  _rejected   integer := 0;
  _last       jsonb;
  _last_ts    timestamptz;
  _last_cores integer;
  -- variables de validation d'un point
  _ts timestamptz; _cores integer; _l1 real; _l5 real; _l15 real; _cpu real;
  _mt integer; _mu integer; _ma integer; _st integer; _su integer;
  _dt integer; _du integer; _da integer; _up bigint; _extra jsonb;
  _mem_pct real; _swap_pct real; _disk_pct real;
begin
  -- 1. Authentification : identité dérivée du seul token -------------------------------------------
  if _token is null or _token !~ '^ikh_[0-9a-f]{12}_[0-9a-f]{64}$' then
    raise exception 'unauthorized' using errcode = 'PT401';
  end if;
  _hash := sha256(convert_to(substr(_token, 18), 'UTF8'));

  select h.* into _h
  from public.web_hostings h
  where h.token_public_id = substr(_token, 5, 12) and h.token_active;
  if not found then
    raise exception 'unauthorized' using errcode = 'PT401';
  end if;

  select * into _cred from public.web_hosting_credentials where web_hosting_id = _h.id;
  if not found or not (
       (_cred.token_hash is not null and _cred.token_hash = _hash)
    or (_cred.prev_token_hash is not null and _cred.prev_token_hash = _hash
        and _cred.prev_token_expires_at > _now)
  ) then
    raise exception 'unauthorized' using errcode = 'PT401';
  end if;

  if not _h.is_active then
    raise exception 'hosting disabled' using errcode = 'PT403';
  end if;

  -- 2. Rate limit : au plus un heartbeat toutes les 20 s par hébergement ---------------------------
  select * into _state from public.web_hosting_state where web_hosting_id = _h.id;
  if found and _state.last_seen_at > _now - interval '20 seconds' then
    raise exception 'rate limited' using errcode = 'PT429';
  end if;

  -- 3. Validation structurelle ----------------------------------------------------------------------
  if jsonb_typeof(_payload) is distinct from 'object' or octet_length(_payload::text) > 16384 then
    raise exception 'invalid payload' using errcode = 'PT400';
  end if;
  if (_payload ->> 'v') is distinct from '1' then
    raise exception 'unsupported protocol version' using errcode = 'PT400';
  end if;

  _points := coalesce(_payload -> 'points', '[]'::jsonb);
  if jsonb_typeof(_points) is distinct from 'array' or jsonb_array_length(_points) > 30 then
    raise exception 'invalid points' using errcode = 'PT400';
  end if;

  _agent := case when jsonb_typeof(_payload -> 'agent') = 'object' then _payload -> 'agent' else '{}'::jsonb end;

  _version := _payload ->> 'agent_version';
  if _version is null or _version !~ '^[0-9A-Za-z._+-]{1,32}$' then _version := null; end if;
  _hostname := _payload ->> 'hostname';
  if _hostname is null or _hostname !~ '^[A-Za-z0-9._-]{1,255}$' then _hostname := null; end if;
  _last_error := nullif(left(regexp_replace(coalesce(_agent ->> 'last_error', ''), '[^ -~]', '?', 'g'), 200), '');

  begin _backlog := least(greatest((_agent ->> 'backlog')::integer, 0), 1000);
  exception when others then _backlog := null; end;
  begin _log_size := greatest((_agent #>> '{log,size}')::bigint, 0);
  exception when others then _log_size := null; end;
  begin _log_inode := greatest((_agent #>> '{log,inode}')::bigint, 0);
  exception when others then _log_inode := null; end;

  -- 4. Ingestion des points : réservée au collecteur système du Cloud ------------------------------
  if jsonb_array_length(_points) > 0 then
    if not _h.system_metrics_collector then
      _anomaly := 'points_ignored';
    else
      for _p in select value from jsonb_array_elements(_points) loop
        begin
          if jsonb_typeof(_p) is distinct from 'object' or jsonb_typeof(_p -> 'ts') is distinct from 'number' then
            raise exception 'bad point';
          end if;
          _ts := to_timestamp((_p ->> 'ts')::bigint);
          if _ts < _now - interval '24 hours' or _ts > _now + interval '2 minutes' then
            raise exception 'ts out of range';
          end if;

          _cores := (_p ->> 'cpu_cores')::integer;
          _l1 := (_p #>> '{load,0}')::real; _l5 := (_p #>> '{load,1}')::real; _l15 := (_p #>> '{load,2}')::real;
          _cpu := nullif(_p ->> 'cpu_pct', '')::real;
          _mt := (_p #>> '{mem,total_mb}')::integer; _mu := (_p #>> '{mem,used_mb}')::integer;
          _ma := (_p #>> '{mem,avail_mb}')::integer;
          _st := (_p #>> '{swap,total_mb}')::integer; _su := (_p #>> '{swap,used_mb}')::integer;
          _dt := (_p #>> '{disk,total_mb}')::integer; _du := (_p #>> '{disk,used_mb}')::integer;
          _da := (_p #>> '{disk,avail_mb}')::integer;
          _up := (_p ->> 'uptime_s')::bigint;
          _extra := coalesce(_p -> 'extra', '{}'::jsonb);

          if _cores is null or _cores not between 1 and 512
             or _l1 is null or _l5 is null or _l15 is null
             or least(_l1, _l5, _l15) < 0 or greatest(_l1, _l5, _l15) > 100000
             or (_cpu is not null and _cpu not between 0 and 100)
             or _mt is null or _mt <= 0 or _mu is null or _mu not between 0 and _mt
             or _ma is null or _ma not between 0 and _mt
             or _st is null or _st < 0 or _su is null or _su not between 0 and _st
             or _dt is null or _dt <= 0 or _du is null or _du not between 0 and _dt
             or _da is null or _da not between 0 and _dt
             or _up is null or _up not between 0 and 10000000000
             or jsonb_typeof(_extra) is distinct from 'object' or octet_length(_extra::text) > 2000
          then
            raise exception 'invalid point';
          end if;

          _mem_pct  := round((100.0 * _mu / _mt)::numeric, 1);
          _swap_pct := case when _st = 0 then 0 else round((100.0 * _su / _st)::numeric, 1) end;
          _disk_pct := round((100.0 * _du / _dt)::numeric, 1);

          insert into public.metrics (
            cloud_server_id, ts, collected_by_hosting_id, cpu_cores,
            load1, load5, load15, load1_per_core, load5_per_core, cpu_pct,
            mem_total_mb, mem_used_mb, mem_avail_mb, mem_used_pct,
            swap_total_mb, swap_used_mb, swap_used_pct,
            disk_total_mb, disk_used_mb, disk_avail_mb, disk_used_pct,
            uptime_s, extra
          ) values (
            _h.cloud_server_id, _ts, _h.id, _cores,
            _l1, _l5, _l15, round((_l1 / _cores)::numeric, 3), round((_l5 / _cores)::numeric, 3), _cpu,
            _mt, _mu, _ma, _mem_pct,
            _st, _su, _swap_pct,
            _dt, _du, _da, _disk_pct,
            _up, _extra
          ) on conflict (cloud_server_id, ts) do nothing;

          _accepted := _accepted + 1;
          if _last_ts is null or _ts > _last_ts then
            _last_ts := _ts;
            _last_cores := _cores;
            _last := jsonb_build_object(
              'ts', extract(epoch from _ts)::bigint, 'cpu_cores', _cores,
              'load1', _l1, 'load5', _l5, 'load15', _l15,
              'load1_per_core', round((_l1 / _cores)::numeric, 3), 'cpu_pct', _cpu,
              'mem_total_mb', _mt, 'mem_used_mb', _mu, 'mem_avail_mb', _ma, 'mem_used_pct', _mem_pct,
              'swap_total_mb', _st, 'swap_used_mb', _su, 'swap_used_pct', _swap_pct,
              'disk_total_mb', _dt, 'disk_used_mb', _du, 'disk_avail_mb', _da, 'disk_used_pct', _disk_pct,
              'uptime_s', _up
            );
          end if;
        exception when others then
          _rejected := _rejected + 1;
        end;
      end loop;

      if _last is not null then
        insert into public.cloud_server_state as s
          (cloud_server_id, workspace_id, last_metrics_at, last_received_at, last_point)
        values (_h.cloud_server_id, _h.workspace_id, _last_ts, _now, _last)
        on conflict (cloud_server_id) do update set
          last_received_at = excluded.last_received_at,
          last_metrics_at  = greatest(s.last_metrics_at, excluded.last_metrics_at),
          last_point       = case when excluded.last_metrics_at > s.last_metrics_at
                                  then excluded.last_point else s.last_point end,
          updated_at       = _now;

        -- Le Cloud apprend son hostname et son nombre de cœurs au premier relevé.
        update public.cloud_servers
           set hostname  = coalesce(hostname, _hostname),
               cpu_cores = coalesce(cpu_cores, _last_cores)
         where id = _h.cloud_server_id and (hostname is null or cpu_cores is null);
      end if;
    end if;
  end if;

  -- 5. Cohérence : tous les hébergements d'un Cloud partagent le même hostname ---------------------
  select hostname into _cloud_host from public.cloud_servers where id = _h.cloud_server_id;
  if _anomaly is null and _hostname is not null and _cloud_host is not null and _hostname <> _cloud_host then
    _anomaly := 'hostname_mismatch';
  end if;

  -- 6. État de l'agent ------------------------------------------------------------------------------
  insert into public.web_hosting_state as s
    (web_hosting_id, workspace_id, last_seen_at, agent_version, hostname_seen, backlog, last_error,
     log_size_bytes, log_inode, anomaly, updated_at)
  values (_h.id, _h.workspace_id, _now, _version, _hostname, _backlog, _last_error,
          _log_size, _log_inode, _anomaly, _now)
  on conflict (web_hosting_id) do update set
    last_seen_at = excluded.last_seen_at, agent_version = excluded.agent_version,
    hostname_seen = excluded.hostname_seen, backlog = excluded.backlog, last_error = excluded.last_error,
    log_size_bytes = excluded.log_size_bytes, log_inode = excluded.log_inode,
    anomaly = excluded.anomaly, updated_at = excluded.updated_at;

  return jsonb_build_object(
    'ok', true,
    'server_time', extract(epoch from _now)::bigint,
    'collector', _h.system_metrics_collector,
    'accepted', _accepted,
    'rejected', _rejected,
    'actions', '[]'::jsonb        -- phase 7 : liste blanche d'actions (analyze_logs)
  );
end;
$$;

revoke all on function public.agent_heartbeat(jsonb) from public;
grant execute on function public.agent_heartbeat(jsonb) to anon, authenticated;
