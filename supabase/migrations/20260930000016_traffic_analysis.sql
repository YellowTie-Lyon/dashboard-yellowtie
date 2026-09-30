-- Phase 11 : analyse du trafic pour la défense (agent 0.4.0) — motifs de paramètres, user-agents, IP par domaine, détail par domaine.
-- Nouvelles colonnes de traffic_detail (vides pour les fenêtres reçues d'un agent plus ancien) ; les lectures les exposent pour
-- le « rapport pour ChatGPT » et les règles Cloudflare suggérées (calculées dans l'interface, à partir de ces agrégats seulement).
alter table public.traffic_detail
  add column queries   jsonb not null default '[]'::jsonb,   -- [{h, q, n, e}] : NOMS de paramètres triés, jamais leurs valeurs
  add column uas       jsonb not null default '[]'::jsonb,   -- [{ua, n}] : user-agents les plus fréquents (70 caractères)
  add column ipdomains jsonb not null default '[]'::jsonb,   -- [{ip, h, n}]
  add column domdetail jsonb not null default '[]'::jsonb;   -- [{h, pc, n4, n3}] : URL distinctes, 404, 401/403

create or replace function public.ingest_traffic(_hosting_id uuid, _workspace_id uuid, _traffic jsonb)
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
  _queries  jsonb;
  _uas      jsonb;
  _ipdom    jsonb;
  _domdet   jsonb;
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
               'n', least((u ->> 'n')::integer, 100000000), 'e', least(coalesce((u ->> 'e')::integer, 0), 100000000),
               'm', least(coalesce((u ->> 'm')::integer, 0), 100000000))), '[]'::jsonb)
        into _paths
        from (select value u from jsonb_array_elements(case when jsonb_typeof(_b -> 'u') = 'array' then _b -> 'u' else '[]'::jsonb end) limit 30) x;
      select coalesce(jsonb_agg(jsonb_build_object(
               'ip', left(regexp_replace(coalesce(i ->> 'ip', ''), '[^0-9a-fA-F:.]', '', 'g'), 45),
               'n', least((i ->> 'n')::integer, 100000000))), '[]'::jsonb)
        into _ips
        from (select value i from jsonb_array_elements(case when jsonb_typeof(_b -> 'i') = 'array' then _b -> 'i' else '[]'::jsonb end) limit 20) x;

      -- Motifs de paramètres (noms seulement), user-agents, IP par domaine, détail par domaine (agent 0.4.0 ; absents des versions plus anciennes).
      select coalesce(jsonb_agg(jsonb_build_object(
               'h', left(regexp_replace(coalesce(q ->> 'h', ''), '[^a-z0-9.-]', '_', 'g'), 100),
               'q', left(regexp_replace(coalesce(q ->> 'q', ''), '[^A-Za-z0-9_.,+-]', '_', 'g'), 90),
               'n', least((q ->> 'n')::integer, 100000000), 'e', least(coalesce((q ->> 'e')::integer, 0), 100000000))), '[]'::jsonb)
        into _queries
        from (select value q from jsonb_array_elements(case when jsonb_typeof(_b -> 'q') = 'array' then _b -> 'q' else '[]'::jsonb end) limit 12) x;
      select coalesce(jsonb_agg(jsonb_build_object(
               'ua', left(regexp_replace(coalesce(a ->> 'ua', ''), '[^A-Za-z0-9 ._/;:()+,-]', '_', 'g'), 70),
               'n', least((a ->> 'n')::integer, 100000000))), '[]'::jsonb)
        into _uas
        from (select value a from jsonb_array_elements(case when jsonb_typeof(_b -> 'a') = 'array' then _b -> 'a' else '[]'::jsonb end) limit 10) x;
      select coalesce(jsonb_agg(jsonb_build_object(
               'ip', left(regexp_replace(coalesce(x ->> 'ip', ''), '[^0-9a-fA-F:.]', '', 'g'), 45),
               'h', left(regexp_replace(coalesce(x ->> 'h', ''), '[^a-z0-9.-]', '_', 'g'), 100),
               'n', least((x ->> 'n')::integer, 100000000))), '[]'::jsonb)
        into _ipdom
        from (select value x from jsonb_array_elements(case when jsonb_typeof(_b -> 'x') = 'array' then _b -> 'x' else '[]'::jsonb end) limit 10) y;
      select coalesce(jsonb_agg(jsonb_build_object(
               'h', left(regexp_replace(coalesce(dm ->> 'h', ''), '[^a-z0-9.-]', '_', 'g'), 100),
               'pc', least(coalesce((dm ->> 'pc')::integer, 0), 1000000),
               'n4', least(coalesce((dm ->> 'n4')::integer, 0), 100000000),
               'n3', least(coalesce((dm ->> 'n3')::integer, 0), 100000000))), '[]'::jsonb)
        into _domdet
        from (select value dm from jsonb_array_elements(case when jsonb_typeof(_b -> 'dm') = 'array' then _b -> 'dm' else '[]'::jsonb end) limit 12) x;
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

      insert into public.traffic_detail (web_hosting_id, workspace_id, ts, totals, paths, ips, agents, queries, uas, ipdomains, domdetail)
      values (_hosting_id, _workspace_id, _ts, _totals, _paths, _ips, _agents, _queries, _uas, _ipdom, _domdet)
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

create or replace function public.get_hosting_traffic(_hosting_id uuid, _minutes integer default 60)
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
                        'errors', sum((p ->> 'e')::integer), 'posts', sum(coalesce((p ->> 'm')::integer, 0))) x
                   from public.traffic_detail d, jsonb_array_elements(d.paths) p
                  where d.web_hosting_id = _hosting_id and d.ts >= _from
                  group by p ->> 'h', p ->> 'p' order by sum((p ->> 'n')::integer) desc limit 20) q), '[]'::jsonb),
    'queries', coalesce((select jsonb_agg(x) from (
                 select jsonb_build_object('domain', q ->> 'h', 'query', q ->> 'q', 'requests', sum((q ->> 'n')::integer), 'errors', sum(coalesce((q ->> 'e')::integer, 0))) x
                   from public.traffic_detail d, jsonb_array_elements(d.queries) q
                  where d.web_hosting_id = _hosting_id and d.ts >= _from
                  group by q ->> 'h', q ->> 'q' order by sum((q ->> 'n')::integer) desc limit 15) q), '[]'::jsonb),
    'uas', coalesce((select jsonb_agg(x) from (
                 select jsonb_build_object('ua', a ->> 'ua', 'requests', sum((a ->> 'n')::integer)) x
                   from public.traffic_detail d, jsonb_array_elements(d.uas) a
                  where d.web_hosting_id = _hosting_id and d.ts >= _from
                  group by a ->> 'ua' order by sum((a ->> 'n')::integer) desc limit 12) q), '[]'::jsonb),
    'ipdomains', coalesce((select jsonb_agg(x) from (
                 select jsonb_build_object('ip', v ->> 'ip', 'domain', v ->> 'h', 'requests', sum((v ->> 'n')::integer)) x
                   from public.traffic_detail d, jsonb_array_elements(d.ipdomains) v
                  where d.web_hosting_id = _hosting_id and d.ts >= _from
                  group by v ->> 'ip', v ->> 'h' order by sum((v ->> 'n')::integer) desc limit 12) q), '[]'::jsonb),
    'domdetail', coalesce((select jsonb_agg(x) from (
                 select jsonb_build_object('domain', z ->> 'h', 'distinct_paths', max((z ->> 'pc')::integer), 'not_found', sum((z ->> 'n4')::integer),
                        'denied', sum((z ->> 'n3')::integer)) x
                   from public.traffic_detail d, jsonb_array_elements(d.domdetail) z
                  where d.web_hosting_id = _hosting_id and d.ts >= _from
                  group by z ->> 'h' order by sum((z ->> 'n4')::integer) desc limit 20) q), '[]'::jsonb),
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

create or replace function public.compute_incident_traffic(_cloud_server_id uuid, _from timestamptz, _to timestamptz)
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
    'totals', (select jsonb_build_object('r4xx', coalesce(sum(t.r4xx), 0), 'r5xx', coalesce(sum(t.r5xx), 0), 'posts', coalesce(sum(t.posts), 0), 'bots', coalesce(sum(t.bots), 0))
                 from public.traffic_5m t join public.web_hostings h on h.id = t.web_hosting_id
                where h.cloud_server_id = _cloud_server_id and t.ts >= _from - interval '5 minutes' and t.ts <= _to),
    'hostings', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('hosting_id', web_hosting_id, 'name', hosting_name, 'requests', sum(requests),
               'share', round(100.0 * sum(requests) / (select n from total), 1)) x
          from src group by web_hosting_id, hosting_name order by sum(requests) desc limit 6) q), '[]'::jsonb),
    'domains', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('domain', domain, 'hosting_id', web_hosting_id, 'hosting', hosting_name, 'requests', sum(requests),
               'r5xx', sum(r5xx), 'share', round(100.0 * sum(requests) / (select n from total), 1)) x
          from src group by domain, web_hosting_id, hosting_name order by sum(requests) desc, domain limit 10) q), '[]'::jsonb),
    'paths', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('domain', p ->> 'h', 'path', p ->> 'p', 'requests', sum((p ->> 'n')::integer),
               'errors', sum(coalesce((p ->> 'e')::integer, 0)), 'posts', sum(coalesce((p ->> 'm')::integer, 0))) x
          from public.traffic_detail d join public.web_hostings h on h.id = d.web_hosting_id, jsonb_array_elements(d.paths) p
         where h.cloud_server_id = _cloud_server_id and d.ts >= _from and d.ts <= _to + interval '5 minutes'
         group by p ->> 'h', p ->> 'p' order by sum((p ->> 'n')::integer) desc limit 15) q), '[]'::jsonb),
    'queries', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('domain', q ->> 'h', 'query', q ->> 'q', 'requests', sum((q ->> 'n')::integer), 'errors', sum(coalesce((q ->> 'e')::integer, 0))) x
          from public.traffic_detail d join public.web_hostings h on h.id = d.web_hosting_id, jsonb_array_elements(d.queries) q
         where h.cloud_server_id = _cloud_server_id and d.ts >= _from and d.ts <= _to + interval '5 minutes'
         group by q ->> 'h', q ->> 'q' order by sum((q ->> 'n')::integer) desc limit 15) q), '[]'::jsonb),
    'uas', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('ua', a ->> 'ua', 'requests', sum((a ->> 'n')::integer)) x
          from public.traffic_detail d join public.web_hostings h on h.id = d.web_hosting_id, jsonb_array_elements(d.uas) a
         where h.cloud_server_id = _cloud_server_id and d.ts >= _from and d.ts <= _to + interval '5 minutes'
         group by a ->> 'ua' order by sum((a ->> 'n')::integer) desc limit 12) q), '[]'::jsonb),
    'ips', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('ip', i ->> 'ip', 'requests', sum((i ->> 'n')::integer)) x
          from public.traffic_detail d join public.web_hostings h on h.id = d.web_hosting_id, jsonb_array_elements(d.ips) i
         where h.cloud_server_id = _cloud_server_id and d.ts >= _from and d.ts <= _to + interval '5 minutes'
         group by i ->> 'ip' order by sum((i ->> 'n')::integer) desc limit 12) q), '[]'::jsonb),
    'ipdomains', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('ip', v ->> 'ip', 'domain', v ->> 'h', 'requests', sum((v ->> 'n')::integer)) x
          from public.traffic_detail d join public.web_hostings h on h.id = d.web_hosting_id, jsonb_array_elements(d.ipdomains) v
         where h.cloud_server_id = _cloud_server_id and d.ts >= _from and d.ts <= _to + interval '5 minutes'
         group by v ->> 'ip', v ->> 'h' order by sum((v ->> 'n')::integer) desc limit 12) q), '[]'::jsonb),
    'domdetail', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('domain', z ->> 'h', 'distinct_paths', max((z ->> 'pc')::integer), 'not_found', sum((z ->> 'n4')::integer), 'denied', sum((z ->> 'n3')::integer)) x
          from public.traffic_detail d join public.web_hostings h on h.id = d.web_hosting_id, jsonb_array_elements(d.domdetail) z
         where h.cloud_server_id = _cloud_server_id and d.ts >= _from and d.ts <= _to + interval '5 minutes'
         group by z ->> 'h' order by sum((z ->> 'n4')::integer) desc limit 20) q), '[]'::jsonb)
  );
$$;
