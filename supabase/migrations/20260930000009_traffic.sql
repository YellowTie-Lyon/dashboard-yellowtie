-- Phase 7 : trafic HTTP par domaine (analyse des access.log par l'agent 0.3.0, agrégats seulement).
--
-- Principe : les lignes de log ne quittent jamais l'hébergement. Toutes les 5 minutes, l'agent envoie un « seau » agrégé
-- (par domaine : requêtes, octets, codes, POST, robots ; plus les URL, IP et types de visiteurs les plus fréquents).
-- Conservation courte pour ménager les quotas : détail 3 jours, agrégat horaire par domaine 30 jours.
-- Un volume élevé de requêtes n'est jamais présenté comme une cause : « potentiellement impliqué ».

alter table public.web_hosting_state add column traffic_last_ts timestamptz;   -- fin de la dernière fenêtre acceptée (anti-doublon)
alter table public.incidents add column traffic_snapshot jsonb;                -- trafic pendant l'incident, figé à sa clôture

-- ---------------------------------------------------------------------------
-- Tables (lecture par les membres, aucune écriture depuis le client)
-- ---------------------------------------------------------------------------
create table public.traffic_5m (
  web_hosting_id uuid        not null references public.web_hostings (id) on delete cascade,
  workspace_id   uuid        not null references public.workspaces (id) on delete cascade,
  ts             timestamptz not null,               -- début du seau de 5 minutes
  domain         text        not null check (domain ~ '^[a-z0-9.()-]{1,100}$'),
  requests       integer     not null check (requests >= 0),
  bytes          bigint      not null check (bytes >= 0),
  r2xx           integer     not null default 0,
  r3xx           integer     not null default 0,
  r4xx           integer     not null default 0,
  r5xx           integer     not null default 0,
  posts          integer     not null default 0,
  bots           integer     not null default 0,
  primary key (web_hosting_id, ts, domain)
);
create index traffic_5m_ts_idx on public.traffic_5m (ts);

create table public.traffic_1h (like public.traffic_5m including all);
alter table public.traffic_1h add foreign key (web_hosting_id) references public.web_hostings (id) on delete cascade;
alter table public.traffic_1h add foreign key (workspace_id) references public.workspaces (id) on delete cascade;

-- Détail d'une fenêtre d'analyse : URL, IP et types de visiteurs les plus fréquents (pas de ligne brute).
create table public.traffic_detail (
  web_hosting_id uuid        not null references public.web_hostings (id) on delete cascade,
  workspace_id   uuid        not null references public.workspaces (id) on delete cascade,
  ts             timestamptz not null,               -- fin de la fenêtre
  totals         jsonb       not null,               -- {win, lines, bad, trunc, n, b, s:[2xx,3xx,4xx,5xx], m}
  paths          jsonb       not null default '[]'::jsonb,   -- [{h, p, n, e}]
  ips            jsonb       not null default '[]'::jsonb,   -- [{ip, n}]
  agents         jsonb       not null default '{}'::jsonb,   -- {g, b, h, e}
  primary key (web_hosting_id, ts)
);
create index traffic_detail_ts_idx on public.traffic_detail (ts);

alter table public.traffic_5m enable row level security;
alter table public.traffic_1h enable row level security;
alter table public.traffic_detail enable row level security;
revoke all on public.traffic_5m, public.traffic_1h, public.traffic_detail from anon, authenticated;
grant select on public.traffic_5m, public.traffic_1h, public.traffic_detail to authenticated;
create policy traffic_5m_select on public.traffic_5m for select to authenticated using (public.is_workspace_member(workspace_id));
create policy traffic_1h_select on public.traffic_1h for select to authenticated using (public.is_workspace_member(workspace_id));
create policy traffic_detail_select on public.traffic_detail for select to authenticated using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Ingestion (interne) : jusqu'à 3 fenêtres par heartbeat, validation stricte, une fenêtre invalide est ignorée.
-- ---------------------------------------------------------------------------
create function public.ingest_traffic(_hosting_id uuid, _workspace_id uuid, _traffic jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  _now      timestamptz := now();
  _last     timestamptz;
  _b        jsonb;
  _ts       timestamptz;
  _bucket   timestamptz;
  _win      integer;
  _accepted integer := 0;
  _max_ts   timestamptz;
  _paths    jsonb;
  _ips      jsonb;
  _agents   jsonb;
  _totals   jsonb;
begin
  if jsonb_typeof(_traffic) is distinct from 'array' or jsonb_array_length(_traffic) > 3 then
    return 0;
  end if;
  select traffic_last_ts into _last from public.web_hosting_state where web_hosting_id = _hosting_id;

  for _b in select value from jsonb_array_elements(_traffic) order by value ->> 'ts' loop
    begin
      if jsonb_typeof(_b) is distinct from 'object' or (_b ->> 'ts') !~ '^[0-9]{9,11}$' then raise exception 'bad bucket'; end if;
      _ts := to_timestamp((_b ->> 'ts')::bigint);
      if _ts < _now - interval '24 hours' or _ts > _now + interval '2 minutes' then raise exception 'ts out of range'; end if;
      if _last is not null and _ts <= _last then continue; end if;   -- déjà reçue (renvoi après une réponse perdue)
      _win := (_b ->> 'win')::integer;
      if _win not between 1 and 3600 then raise exception 'bad window'; end if;
      _bucket := to_timestamp(floor(extract(epoch from _ts - make_interval(secs => 1)) / 300) * 300);
      if jsonb_typeof(_b -> 'd') is distinct from 'array' or jsonb_array_length(_b -> 'd') > 60 then raise exception 'bad domains'; end if;

      insert into public.traffic_5m as t
        (web_hosting_id, workspace_id, ts, domain, requests, bytes, r2xx, r3xx, r4xx, r5xx, posts, bots)
      select _hosting_id, _workspace_id, _bucket, q.dom,
             sum((q.d ->> 'n')::integer), sum((q.d ->> 'b')::bigint),
             sum(coalesce((q.d #>> '{s,0}')::integer, 0)), sum(coalesce((q.d #>> '{s,1}')::integer, 0)),
             sum(coalesce((q.d #>> '{s,2}')::integer, 0)), sum(coalesce((q.d #>> '{s,3}')::integer, 0)),
             sum(coalesce((q.d ->> 'm')::integer, 0)), sum(coalesce((q.d ->> 'bt')::integer, 0))
      from (select d, case when d ->> 'h' ~ '^[a-z0-9.-]{1,100}$' then d ->> 'h' else '(autre)' end dom
              from jsonb_array_elements(_b -> 'd') d
             where (d ->> 'n')::integer between 0 and 100000000 and (d ->> 'b')::bigint between 0 and 10000000000000) q
      group by q.dom
      on conflict (web_hosting_id, ts, domain) do update set
        requests = t.requests + excluded.requests, bytes = t.bytes + excluded.bytes,
        r2xx = t.r2xx + excluded.r2xx, r3xx = t.r3xx + excluded.r3xx, r4xx = t.r4xx + excluded.r4xx,
        r5xx = t.r5xx + excluded.r5xx, posts = t.posts + excluded.posts, bots = t.bots + excluded.bots;

      select coalesce(jsonb_agg(jsonb_build_object(
               'h', left(regexp_replace(coalesce(u ->> 'h', ''), '[^a-z0-9.-]', '_', 'g'), 100),
               'p', left(regexp_replace(coalesce(u ->> 'p', ''), '[^ -~]', '_', 'g'), 120),
               'n', least((u ->> 'n')::integer, 100000000), 'e', least(coalesce((u ->> 'e')::integer, 0), 100000000))), '[]'::jsonb)
        into _paths
        from (select value u from jsonb_array_elements(case when jsonb_typeof(_b -> 'u') = 'array' then _b -> 'u' else '[]'::jsonb end) limit 30) x;
      select coalesce(jsonb_agg(jsonb_build_object(
               'ip', left(regexp_replace(coalesce(i ->> 'ip', ''), '[^0-9a-fA-F:.]', '', 'g'), 45),
               'n', least((i ->> 'n')::integer, 100000000))), '[]'::jsonb)
        into _ips
        from (select value i from jsonb_array_elements(case when jsonb_typeof(_b -> 'i') = 'array' then _b -> 'i' else '[]'::jsonb end) limit 20) x;
      _agents := jsonb_build_object(
        'g', least(coalesce((_b #>> '{ua,g}')::integer, 0), 100000000), 'b', least(coalesce((_b #>> '{ua,b}')::integer, 0), 100000000),
        'h', least(coalesce((_b #>> '{ua,h}')::integer, 0), 100000000), 'e', least(coalesce((_b #>> '{ua,e}')::integer, 0), 100000000));
      _totals := jsonb_build_object(
        'win', _win, 'lines', least(coalesce((_b ->> 'lines')::integer, 0), 1000000000), 'bad', least(coalesce((_b ->> 'bad')::integer, 0), 1000000000),
        'trunc', coalesce((_b ->> 'trunc')::integer, 0) = 1, 'n', least((_b ->> 'n')::integer, 1000000000),
        'b', least((_b ->> 'b')::bigint, 10000000000000),
        's', jsonb_build_array(coalesce((_b #>> '{s,0}')::integer, 0), coalesce((_b #>> '{s,1}')::integer, 0),
                               coalesce((_b #>> '{s,2}')::integer, 0), coalesce((_b #>> '{s,3}')::integer, 0)),
        'm', coalesce((_b ->> 'm')::integer, 0));

      insert into public.traffic_detail (web_hosting_id, workspace_id, ts, totals, paths, ips, agents)
      values (_hosting_id, _workspace_id, _ts, _totals, _paths, _ips, _agents)
      on conflict (web_hosting_id, ts) do nothing;

      _accepted := _accepted + 1;
      if _max_ts is null or _ts > _max_ts then _max_ts := _ts; end if;
    exception when others then
      null;   -- fenêtre invalide : ignorée, les suivantes restent traitées
    end;
  end loop;

  if _max_ts is not null then
    update public.web_hosting_state set traffic_last_ts = greatest(coalesce(traffic_last_ts, _max_ts), _max_ts)
     where web_hosting_id = _hosting_id;
  end if;
  return _accepted;
end;
$$;
revoke all on function public.ingest_traffic(uuid, uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Porte d'entrée : le champ « traffic » est retiré avant l'appel de la logique existante (limite de 16 Ko conservée pour
-- le reste) puis ingéré seulement si l'authentification et le rate limit ont réussi. Limite globale : 64 Ko.
-- ---------------------------------------------------------------------------
alter function public.agent_heartbeat(jsonb) rename to agent_heartbeat_v1;
revoke all on function public.agent_heartbeat_v1(jsonb) from public, anon, authenticated;

create function public.agent_heartbeat(jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _payload jsonb := $1;
  _traffic jsonb;
  _result  jsonb;
  _token   text := (coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb) ->> 'x-agent-token';
  _h       public.web_hostings;
  _n       integer := 0;
begin
  if jsonb_typeof(_payload) = 'object' and octet_length(_payload::text) <= 65536 and _payload ? 'traffic' then
    _traffic := _payload -> 'traffic';
    _payload := _payload - 'traffic';
  elsif jsonb_typeof(_payload) = 'object' and octet_length(_payload::text) > 65536 then
    raise exception 'invalid payload' using errcode = 'PT400';
  end if;

  _result := public.agent_heartbeat_v1(_payload);

  if _traffic is not null and _token ~ '^ikh_[0-9a-f]{12}_[0-9a-f]{64}$' then
    select * into _h from public.web_hostings where token_public_id = substr(_token, 5, 12) and token_active;
    if found then
      begin
        _n := public.ingest_traffic(_h.id, _h.workspace_id, _traffic);
      exception when others then
        _n := 0;
      end;
    end if;
  end if;
  return _result || jsonb_build_object('traffic_accepted', _n);
end;
$$;
revoke all on function public.agent_heartbeat(jsonb) from public;
grant execute on function public.agent_heartbeat(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Lectures (SECURITY INVOKER : la RLS s'applique)
-- ---------------------------------------------------------------------------

-- Domaines les plus sollicités d'un Server Cloud sur une période (comptage brut, jamais une cause).
create function public.get_top_domains(_cloud_server_id uuid, _minutes integer default 60, _limit integer default 10)
returns table (
  domain text, web_hosting_id uuid, hosting_name text,
  requests bigint, bytes bigint, r4xx bigint, r5xx bigint, posts bigint, bots bigint, share numeric
)
language sql
stable
set search_path = ''
as $$
  with src as (
    select t.web_hosting_id, t.domain, t.requests, t.bytes, t.r4xx, t.r5xx, t.posts, t.bots
      from public.traffic_5m t
     where _minutes <= 4320 and t.ts >= now() - make_interval(mins => least(greatest(_minutes, 5), 4320))
       and t.web_hosting_id in (select id from public.web_hostings where cloud_server_id = _cloud_server_id)
    union all
    select t.web_hosting_id, t.domain, t.requests, t.bytes, t.r4xx, t.r5xx, t.posts, t.bots
      from public.traffic_1h t
     where _minutes > 4320 and t.ts >= now() - make_interval(mins => least(_minutes, 43200))
       and t.web_hosting_id in (select id from public.web_hostings where cloud_server_id = _cloud_server_id)
  ), agg as (
    select s.domain, s.web_hosting_id, sum(s.requests) requests, sum(s.bytes) bytes, sum(s.r4xx) r4xx,
           sum(s.r5xx) r5xx, sum(s.posts) posts, sum(s.bots) bots
      from src s group by s.domain, s.web_hosting_id
  ), total as (select nullif(sum(requests), 0) n from agg)
  select a.domain, a.web_hosting_id, h.name, a.requests::bigint, a.bytes::bigint, a.r4xx::bigint, a.r5xx::bigint,
         a.posts::bigint, a.bots::bigint, round(100.0 * a.requests / (select n from total), 1)
    from agg a join public.web_hostings h on h.id = a.web_hosting_id
   order by a.requests desc, a.domain
   limit least(greatest(_limit, 1), 100);
$$;

-- Vue complète du trafic d'un hébergement : totaux, domaines, URL, IP, visiteurs, courbe.
create function public.get_hosting_traffic(_hosting_id uuid, _minutes integer default 60)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  _from    timestamptz := now() - make_interval(mins => least(greatest(_minutes, 5), 4320));
  _result  jsonb;
begin
  if not exists (select 1 from public.web_hostings where id = _hosting_id) then return null; end if;
  select jsonb_build_object(
    'minutes', least(greatest(_minutes, 5), 4320),
    'totals', (select jsonb_build_object(
                 'requests', coalesce(sum(requests), 0), 'bytes', coalesce(sum(bytes), 0),
                 'r2xx', coalesce(sum(r2xx), 0), 'r3xx', coalesce(sum(r3xx), 0),
                 'r4xx', coalesce(sum(r4xx), 0), 'r5xx', coalesce(sum(r5xx), 0),
                 'posts', coalesce(sum(posts), 0), 'bots', coalesce(sum(bots), 0))
               from public.traffic_5m where web_hosting_id = _hosting_id and ts >= _from),
    'sampled', coalesce((select bool_or((totals ->> 'trunc')::boolean) from public.traffic_detail
                          where web_hosting_id = _hosting_id and ts >= _from), false),
    'last_at', (select max(ts) from public.traffic_detail where web_hosting_id = _hosting_id),
    'domains', coalesce((select jsonb_agg(x) from (
                 select jsonb_build_object('domain', domain, 'requests', sum(requests), 'bytes', sum(bytes),
                        'r4xx', sum(r4xx), 'r5xx', sum(r5xx), 'posts', sum(posts), 'bots', sum(bots)) x
                   from public.traffic_5m where web_hosting_id = _hosting_id and ts >= _from
                  group by domain order by sum(requests) desc, domain limit 20) q), '[]'::jsonb),
    'series', coalesce((select jsonb_agg(x order by (x ->> 'ts')) from (
                 select jsonb_build_object('ts', extract(epoch from ts)::bigint, 'n', sum(requests),
                        'e4', sum(r4xx), 'e5', sum(r5xx)) x
                   from public.traffic_5m where web_hosting_id = _hosting_id and ts >= _from group by ts) q), '[]'::jsonb),
    'paths', coalesce((select jsonb_agg(x) from (
                 select jsonb_build_object('domain', p ->> 'h', 'path', p ->> 'p', 'requests', sum((p ->> 'n')::integer),
                        'errors', sum((p ->> 'e')::integer)) x
                   from public.traffic_detail d, jsonb_array_elements(d.paths) p
                  where d.web_hosting_id = _hosting_id and d.ts >= _from
                  group by p ->> 'h', p ->> 'p' order by sum((p ->> 'n')::integer) desc limit 20) q), '[]'::jsonb),
    'ips', coalesce((select jsonb_agg(x) from (
                 select jsonb_build_object('ip', i ->> 'ip', 'requests', sum((i ->> 'n')::integer)) x
                   from public.traffic_detail d, jsonb_array_elements(d.ips) i
                  where d.web_hosting_id = _hosting_id and d.ts >= _from
                  group by i ->> 'ip' order by sum((i ->> 'n')::integer) desc limit 15) q), '[]'::jsonb),
    'agents', (select jsonb_build_object('googlebot', coalesce(sum((agents ->> 'g')::integer), 0),
                        'bots', coalesce(sum((agents ->> 'b')::integer), 0),
                        'browsers', coalesce(sum((agents ->> 'h')::integer), 0),
                        'empty', coalesce(sum((agents ->> 'e')::integer), 0))
                 from public.traffic_detail where web_hosting_id = _hosting_id and ts >= _from)
  ) into _result;
  return _result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Trafic pendant un incident (hébergements et domaines « potentiellement impliqués »)
-- ---------------------------------------------------------------------------
create function public.compute_incident_traffic(_cloud_server_id uuid, _from timestamptz, _to timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with src as (
    select t.web_hosting_id, h.name hosting_name, t.domain, t.requests, t.r5xx, t.r4xx
      from public.traffic_5m t join public.web_hostings h on h.id = t.web_hosting_id
     where h.cloud_server_id = _cloud_server_id and t.ts >= _from - interval '5 minutes' and t.ts <= _to
  ), total as (select nullif(sum(requests), 0) n from src)
  select jsonb_build_object(
    'from', _from, 'to', _to, 'requests', coalesce((select sum(requests) from src), 0),
    'hostings', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('hosting_id', web_hosting_id, 'name', hosting_name, 'requests', sum(requests),
               'share', round(100.0 * sum(requests) / (select n from total), 1)) x
          from src group by web_hosting_id, hosting_name order by sum(requests) desc limit 6) q), '[]'::jsonb),
    'domains', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('domain', domain, 'hosting_id', web_hosting_id, 'hosting', hosting_name, 'requests', sum(requests),
               'r5xx', sum(r5xx), 'share', round(100.0 * sum(requests) / (select n from total), 1)) x
          from src group by domain, web_hosting_id, hosting_name order by sum(requests) desc, domain limit 10) q), '[]'::jsonb),
    'paths', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('domain', p ->> 'h', 'path', p ->> 'p', 'requests', sum((p ->> 'n')::integer)) x
          from public.traffic_detail d join public.web_hostings h on h.id = d.web_hosting_id, jsonb_array_elements(d.paths) p
         where h.cloud_server_id = _cloud_server_id and d.ts >= _from and d.ts <= _to + interval '5 minutes'
         group by p ->> 'h', p ->> 'p' order by sum((p ->> 'n')::integer) desc limit 10) q), '[]'::jsonb)
  );
$$;
revoke all on function public.compute_incident_traffic(uuid, timestamptz, timestamptz) from public, anon, authenticated;

create function public.get_incident_traffic(_incident_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  _i public.incidents;
begin
  select * into _i from public.incidents where id = _incident_id;
  if not found or not public.is_workspace_member(_i.workspace_id) then return null; end if;
  if _i.traffic_snapshot is not null then return _i.traffic_snapshot; end if;
  return public.compute_incident_traffic(_i.cloud_server_id, _i.started_at, coalesce(_i.ended_at, now()));
end;
$$;
revoke all on function public.get_incident_traffic(uuid) from public, anon;
grant execute on function public.get_incident_traffic(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Entretien : agrégat horaire, figeage du trafic des incidents clos, purge
-- ---------------------------------------------------------------------------
create function public.traffic_maintenance()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  _rolled integer;
  _snap   integer;
begin
  -- Heures COMPLÈTES des 3 dernières heures (recalculées : idempotent, le détail de 3 jours couvre tout retard).
  insert into public.traffic_1h as h
    (web_hosting_id, workspace_id, ts, domain, requests, bytes, r2xx, r3xx, r4xx, r5xx, posts, bots)
  select web_hosting_id, workspace_id, date_trunc('hour', ts), domain, sum(requests), sum(bytes), sum(r2xx), sum(r3xx),
         sum(r4xx), sum(r5xx), sum(posts), sum(bots)
    from public.traffic_5m
   where ts >= date_trunc('hour', now()) - interval '3 hours' and ts < date_trunc('hour', now())
   group by web_hosting_id, workspace_id, date_trunc('hour', ts), domain
  on conflict (web_hosting_id, ts, domain) do update set
    requests = excluded.requests, bytes = excluded.bytes, r2xx = excluded.r2xx, r3xx = excluded.r3xx,
    r4xx = excluded.r4xx, r5xx = excluded.r5xx, posts = excluded.posts, bots = excluded.bots;
  get diagnostics _rolled = row_count;

  -- Un incident clos depuis plus de 6 minutes a reçu tous ses seaux : son trafic est figé (la purge à 3 jours ne l'efface pas).
  update public.incidents i
     set traffic_snapshot = public.compute_incident_traffic(i.cloud_server_id, i.started_at, i.ended_at)
   where i.status = 'closed' and i.traffic_snapshot is null and i.ended_at is not null and i.ended_at < now() - interval '6 minutes';
  get diagnostics _snap = row_count;

  insert into public.job_state (name, last_run_at, detail)
  values ('traffic', now(), jsonb_build_object('hourly_rows', _rolled, 'snapshots', _snap))
  on conflict (name) do update set last_run_at = excluded.last_run_at, detail = excluded.detail;
  return jsonb_build_object('hourly_rows', _rolled, 'snapshots', _snap);
end;
$$;

create function public.purge_traffic(_detail_days integer default 3, _hourly_days integer default 30)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  _a integer; _b integer; _c integer;
begin
  if _detail_days < 2 or _hourly_days < 7 then
    raise exception 'retention too short' using errcode = '22023';
  end if;
  delete from public.traffic_5m where ts < now() - make_interval(days => _detail_days);
  get diagnostics _a = row_count;
  delete from public.traffic_detail where ts < now() - make_interval(days => _detail_days);
  get diagnostics _b = row_count;
  delete from public.traffic_1h where ts < now() - make_interval(days => _hourly_days);
  get diagnostics _c = row_count;
  insert into public.job_state (name, last_run_at, detail)
  values ('traffic_purge', now(), jsonb_build_object('detail_deleted', _a + _b, 'hourly_deleted', _c))
  on conflict (name) do update set last_run_at = excluded.last_run_at, detail = excluded.detail;
  return jsonb_build_object('detail_deleted', _a + _b, 'hourly_deleted', _c);
end;
$$;
revoke all on function public.traffic_maintenance() from public, anon, authenticated;
revoke all on function public.purge_traffic(integer, integer) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.schedule('yellowscope-traffic', '*/10 * * * *', 'select public.traffic_maintenance()');
      perform cron.schedule('yellowscope-traffic-purge', '23 3 * * *', 'select public.purge_traffic()');
    exception when others then
      raise notice 'planification pg_cron du trafic impossible : %', sqlerrm;
    end;
  end if;
end;
$$;
