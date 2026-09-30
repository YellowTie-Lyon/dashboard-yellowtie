-- Collecteur de secours : le tableau de bord ne doit pas perdre la charge du Cloud quand l'hébergement du collecteur est étouffé.
-- Le Cloud garde la date du dernier relevé envoyé PAR LE COLLECTEUR DÉSIGNÉ (collector_last_ts) : au-delà de 2 minutes, un seul autre agent
-- actif (le plus petit identifiant) reprend les relevés jusqu'au retour du collecteur. Les relevés sont idempotents (Cloud, ts).
alter table public.cloud_server_state add column collector_last_ts timestamptz;
update public.cloud_server_state set collector_last_ts = last_received_at;

create or replace function public.agent_heartbeat_impl(_payload jsonb)
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
  _backup     boolean := false;
  _rejected   integer := 0;
  _last       jsonb;
  _last_ts    timestamptz;
  _last_cores integer;
  _domains    jsonb;
  _site_count integer;
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

  -- 3 bis. Collecteur de SECOURS : si le collecteur désigné n'a plus rien envoyé depuis 2 minutes (hébergement étouffé par une surcharge,
  -- agent en retard…), UN seul autre agent du Cloud reprend les relevés système (ils décrivent le Cloud entier, pas l'hébergement) : le
  -- tableau de bord continue de suivre la charge quand on en a le plus besoin. L'élu est le plus petit identifiant parmi les agents actifs.
  if not _h.system_metrics_collector then
    _backup := coalesce((select st.collector_last_ts < _now - interval '120 seconds'
                           from public.cloud_server_state st where st.cloud_server_id = _h.cloud_server_id), false)
               and _h.id = (select h2.id
                              from public.web_hostings h2
                              left join public.web_hosting_state hs on hs.web_hosting_id = h2.id
                             where h2.cloud_server_id = _h.cloud_server_id and h2.is_active and not h2.system_metrics_collector
                               and (h2.id = _h.id or hs.last_seen_at > _now - interval '150 seconds')
                             order by h2.id limit 1);
  end if;

  -- 4. Ingestion des points : réservée au collecteur système du Cloud ------------------------------
  if jsonb_array_length(_points) > 0 then
    if not _h.system_metrics_collector and not _backup then
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
          (cloud_server_id, workspace_id, last_metrics_at, last_received_at, last_point, collector_last_ts)
        values (_h.cloud_server_id, _h.workspace_id, _last_ts, _now, _last, case when _h.system_metrics_collector then _now end)
        on conflict (cloud_server_id) do update set
          collector_last_ts = case when _h.system_metrics_collector then _now else s.collector_last_ts end,
          last_received_at = excluded.last_received_at,
          last_metrics_at  = greatest(s.last_metrics_at, excluded.last_metrics_at),
          last_point       = case when excluded.last_metrics_at > s.last_metrics_at
                                  then excluded.last_point else s.last_point end,
          updated_at       = _now;
        if _backup then _anomaly := 'backup_collector'; end if;

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

  -- 5b. Sites déclarés par l'agent : noms des dossiers de ~/sites de l'hébergement ------------------------
  -- Source fiable (dossiers du client lui-même) : créés directement « vérifiés ». Les domaines qui
  -- apparaîtront dans les logs (phase 7) seront, eux, non vérifiés. Rien n'est jamais supprimé ici.
  _domains := _payload -> 'domains';
  if jsonb_typeof(_domains) = 'array' then
    select count(*) into _site_count from public.sites where web_hosting_id = _h.id;
    if _site_count < 500 then
      with cand as (
        select distinct lower(btrim(t.v #>> '{}')) as d
        from jsonb_array_elements(_domains) with ordinality as t(v, ord)
        where t.ord <= 200 and jsonb_typeof(t.v) = 'string'
      )
      insert into public.sites (workspace_id, web_hosting_id, domain, source, is_verified, first_seen_at, last_seen_at)
      select _h.workspace_id, _h.id, d, 'discovered', true, _now, _now
      from cand
      where char_length(d) <= 253
        and d ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$'
      on conflict (web_hosting_id, domain) do update set last_seen_at = _now;
    end if;
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
    'collector', _h.system_metrics_collector or _backup,
    'accepted', _accepted,
    'rejected', _rejected,
    'actions', '[]'::jsonb        -- phase 7 : liste blanche d'actions (analyze_logs)
  );
end;
$$;
