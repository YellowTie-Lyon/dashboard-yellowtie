-- Phase 5 : seuils configurables, statuts des Server Clouds, détection des silences, sondes HTTP.
-- (Aucune notification : les incidents et leur historique viennent en phase 6.)

-- ---------------------------------------------------------------------------
-- Règles de seuil. cloud_server_id NULL = valeur par défaut du workspace ; renseigné = surcharge pour ce Cloud.
-- Tout est donnée modifiable depuis l'interface : aucune valeur n'est codée dans la logique d'évaluation.
-- ---------------------------------------------------------------------------
create table public.alert_rules (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  cloud_server_id  uuid references public.cloud_servers (id) on delete cascade,
  metric           text not null check (metric in (
    'load1_per_core', 'load5_per_core', 'load1', 'load5', 'cpu_pct', 'mem_used_pct', 'swap_used_pct', 'disk_used_pct')),
  warn_threshold   double precision not null check (warn_threshold >= 0),
  crit_threshold   double precision not null check (crit_threshold >= 0),
  window_minutes   integer not null check (window_minutes between 1 and 60),        -- fenêtre d'évaluation
  min_breach_ratio double precision not null check (min_breach_ratio between 0.1 and 1), -- part des relevés au-dessus du seuil
  recover_margin   double precision not null check (recover_margin >= 0),           -- hystérésis : marge sous le seuil
  recover_minutes  integer not null check (recover_minutes between 1 and 120),      -- durée de retour stable
  enabled          boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (crit_threshold > warn_threshold)
);

create unique index alert_rules_default_uniq on public.alert_rules (workspace_id, metric) where cloud_server_id is null;
create unique index alert_rules_cloud_uniq on public.alert_rules (cloud_server_id, metric) where cloud_server_id is not null;

create trigger alert_rules_updated_at before update on public.alert_rules
  for each row execute function public.set_updated_at();

-- Une surcharge ne peut viser qu'un Cloud du même workspace.
create function public.alert_rules_check_cloud()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.cloud_server_id is not null and not exists (
    select 1 from public.cloud_servers c where c.id = new.cloud_server_id and c.workspace_id = new.workspace_id
  ) then
    raise exception 'cloud server does not belong to the workspace' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.alert_rules_check_cloud() from public, anon, authenticated;
create trigger alert_rules_check_cloud before insert or update on public.alert_rules
  for each row execute function public.alert_rules_check_cloud();

-- État de chaque règle pour chaque Cloud (niveau courant) ; alimenté uniquement par l'évaluation.
create table public.alert_state (
  cloud_server_id uuid not null references public.cloud_servers (id) on delete cascade,
  metric          text not null,
  level           text not null check (level in ('ok', 'warning', 'critical')),
  level_since     timestamptz not null,
  updated_at      timestamptz not null default now(),
  primary key (cloud_server_id, metric)
);

-- Statut calculé d'un Cloud (une ligne par Cloud, mise à jour chaque minute).
create table public.cloud_status (
  cloud_server_id uuid primary key references public.cloud_servers (id) on delete cascade,
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  status          text not null check (status in ('normal', 'warning', 'critical', 'offline', 'unknown', 'maintenance')),
  status_since    timestamptz not null,
  detail          jsonb not null default '{}'::jsonb,   -- raisons, connectivité, diagnostic, horodatages
  evaluated_at    timestamptz not null
);

-- Sondes HTTP : résultats (lisibles) et requêtes en vol (internes).
create table public.probe_results (
  id             bigint generated always as identity primary key,
  web_hosting_id uuid not null references public.web_hostings (id) on delete cascade,
  ts             timestamptz not null default now(),
  ok             boolean not null,
  http_status    integer,
  latency_ms     integer,
  error          text
);
create index probe_results_hosting_ts_idx on public.probe_results (web_hosting_id, ts desc);

create table public.probe_requests (
  request_id     bigint primary key,
  web_hosting_id uuid not null references public.web_hostings (id) on delete cascade,
  sent_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS : lecture par les membres ; écriture des règles par le propriétaire uniquement
-- ---------------------------------------------------------------------------
alter table public.alert_rules enable row level security;
alter table public.alert_state enable row level security;
alter table public.cloud_status enable row level security;
alter table public.probe_results enable row level security;
alter table public.probe_requests enable row level security;
revoke all on public.alert_rules, public.alert_state, public.cloud_status, public.probe_results, public.probe_requests from anon, authenticated;

grant select on public.alert_rules to authenticated;
grant insert (workspace_id, cloud_server_id, metric, warn_threshold, crit_threshold, window_minutes,
              min_breach_ratio, recover_margin, recover_minutes, enabled) on public.alert_rules to authenticated;
grant update (warn_threshold, crit_threshold, window_minutes, min_breach_ratio, recover_margin, recover_minutes, enabled)
  on public.alert_rules to authenticated;
grant delete on public.alert_rules to authenticated;
grant select on public.alert_state, public.cloud_status, public.probe_results to authenticated;

create policy alert_rules_select on public.alert_rules for select to authenticated using (public.is_workspace_member(workspace_id));
create policy alert_rules_insert on public.alert_rules for insert to authenticated
  with check (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));
create policy alert_rules_update on public.alert_rules for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));
create policy alert_rules_delete on public.alert_rules for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));
create policy cloud_status_select on public.cloud_status for select to authenticated using (public.is_workspace_member(workspace_id));
create policy alert_state_select on public.alert_state for select to authenticated
  using (exists (select 1 from public.cloud_servers c where c.id = alert_state.cloud_server_id));
create policy probe_results_select on public.probe_results for select to authenticated
  using (exists (select 1 from public.web_hostings h where h.id = probe_results.web_hosting_id));

-- ---------------------------------------------------------------------------
-- Valeurs par défaut (PROVISOIRES : à calibrer avec l'historique réel, voir l'aide de calibrage de l'interface).
-- Semées pour chaque workspace, existant ou futur. Seules 4 règles sont actives au départ.
-- ---------------------------------------------------------------------------
create function public.seed_alert_defaults(_workspace_id uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.alert_rules (workspace_id, cloud_server_id, metric, warn_threshold, crit_threshold, window_minutes,
                                  min_breach_ratio, recover_margin, recover_minutes, enabled)
  values
    (_workspace_id, null, 'load1_per_core', 0.6, 1.0, 5, 0.8, 0.1, 5, true),
    (_workspace_id, null, 'load5_per_core', 0.5, 0.9, 10, 0.8, 0.1, 10, false),
    (_workspace_id, null, 'load1', 8, 12, 5, 0.8, 1, 5, false),
    (_workspace_id, null, 'load5', 7, 11, 10, 0.8, 1, 10, false),
    (_workspace_id, null, 'cpu_pct', 75, 90, 5, 0.8, 5, 5, true),
    (_workspace_id, null, 'mem_used_pct', 85, 95, 5, 0.8, 3, 5, true),
    (_workspace_id, null, 'swap_used_pct', 50, 80, 10, 0.8, 5, 10, false),
    (_workspace_id, null, 'disk_used_pct', 80, 90, 5, 1.0, 2, 10, true)
  on conflict (workspace_id, metric) where cloud_server_id is null do nothing;
$$;
revoke all on function public.seed_alert_defaults(uuid) from public, anon, authenticated;

create function public.workspaces_seed_alerts()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.seed_alert_defaults(new.id);
  return new;
end;
$$;
revoke all on function public.workspaces_seed_alerts() from public, anon, authenticated;
create trigger workspaces_seed_alerts after insert on public.workspaces
  for each row execute function public.workspaces_seed_alerts();

select public.seed_alert_defaults(id) from public.workspaces;

-- ---------------------------------------------------------------------------
-- Évaluation d'un Server Cloud
-- ---------------------------------------------------------------------------
create function public._level_rank(_level text)
returns integer language sql immutable set search_path = '' as
$$ select case _level when 'critical' then 2 when 'warning' then 1 else 0 end $$;

create function public.evaluate_cloud(_cloud_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  _now timestamptz := now();
  c public.cloud_servers;
  st public.cloud_server_state;
  prev public.cloud_status;
  r record;
  _last_agent timestamptz;
  _offline interval;
  _alive boolean; _fresh boolean; _delayed boolean;
  _status text; _conn text; _diag text;
  _reasons jsonb := '[]'::jsonb;
  _active text[] := '{}';
  _crit_seen boolean := false; _warn_seen boolean := false;
  _cur text; _new text; _cand text; _since timestamptz;
  _n integer; _nw integer; _nc integer; _nrec integer; _hw integer; _hc integer;
  _rec_crit boolean; _rec_warn boolean; _val double precision;
  _probe_cfg boolean; _probe_ok boolean; _probe_ko boolean;
begin
  select * into c from public.cloud_servers where id = _cloud_id;
  if not found then return; end if;
  select * into st from public.cloud_server_state where cloud_server_id = _cloud_id;
  select * into prev from public.cloud_status where cloud_server_id = _cloud_id;

  -- 1. Connectivité : un Cloud est « vivant » tant qu'au moins un de ses agents actifs a parlé récemment.
  select max(hs.last_seen_at) into _last_agent
    from public.web_hosting_state hs join public.web_hostings h on h.id = hs.web_hosting_id
   where h.cloud_server_id = _cloud_id and h.is_active;
  _offline := make_interval(secs => c.offline_after_seconds);
  _alive   := _last_agent is not null and _last_agent > _now - _offline;
  _delayed := _alive and _last_agent < _now - interval '90 seconds';
  _fresh   := st.last_received_at is not null and st.last_received_at > _now - _offline;

  if c.maintenance then
    _status := 'maintenance';
    _conn := case when _alive then 'ok' else 'silent' end;
  elsif _last_agent is null then
    _status := 'unknown'; _conn := 'never';
  elsif not _alive then
    _status := 'offline'; _conn := 'silent';
    -- Diagnostic par les sondes (jamais une affirmation : « probable », « potentiellement »).
    select coalesce(bool_or(p.last_ok), false), count(*) > 0, coalesce(bool_and(p.last_ok = false and p.ko2 >= 2), false)
      into _probe_ok, _probe_cfg, _probe_ko
      from (
        select (select pr.ok from public.probe_results pr where pr.web_hosting_id = h.id and pr.ts > _now - interval '6 minutes'
                 order by pr.ts desc limit 1) as last_ok,
               (select count(*) filter (where not x.ok) from (
                  select pr.ok from public.probe_results pr where pr.web_hosting_id = h.id and pr.ts > _now - interval '8 minutes'
                   order by pr.ts desc limit 2) x) as ko2
          from public.web_hostings h
         where h.cloud_server_id = _cloud_id and h.is_active and h.probe_url is not null
      ) p;
    _diag := case when _probe_cfg and _probe_ok then 'agents_silent'
                  when _probe_cfg and _probe_ko then 'unreachable_probable'
                  else 'unknown_cause' end;
  elsif not _fresh then
    _status := 'unknown'; _conn := 'metrics_stale';   -- d'autres agents répondent, pas le collecteur système
  else
    _conn := case when _delayed then 'delayed' else 'ok' end;

    -- 2. Règles : la surcharge du Cloud remplace la valeur par défaut du workspace, métrique par métrique.
    for r in
      select * from (
        select distinct on (a.metric) a.*
          from public.alert_rules a
         where a.workspace_id = c.workspace_id and (a.cloud_server_id = c.id or a.cloud_server_id is null)
         order by a.metric, (a.cloud_server_id is null)
      ) e where e.enabled
    loop
      _active := _active || r.metric;
      _cur := null; _since := null;   -- pas de valeur résiduelle de la règle précédente
      select s.level, s.level_since into _cur, _since from public.alert_state s where s.cloud_server_id = c.id and s.metric = r.metric;
      _cur := coalesce(_cur, 'ok');

      -- Dépassements dans la fenêtre d'évaluation (les relevés manquants ne comptent ni comme dépassement ni comme retour).
      select count(t.v), count(*) filter (where t.v > r.warn_threshold), count(*) filter (where t.v > r.crit_threshold)
        into _n, _nw, _nc
        from (select (to_jsonb(m) ->> r.metric)::double precision as v from public.metrics m
               where m.cloud_server_id = c.id and m.ts >= _now - make_interval(mins => r.window_minutes)) t;

      _cand := null;   -- null = pas assez de relevés : on ne change rien
      if _n >= ceil(r.window_minutes * 0.6) then
        _cand := case when _nc::double precision / _n >= r.min_breach_ratio then 'critical'
                      when _nw::double precision / _n >= r.min_breach_ratio then 'warning'
                      else 'ok' end;
      end if;

      -- Retour à la normale : toutes les valeurs de la fenêtre de récupération sous (seuil - marge).
      select count(t.v), count(*) filter (where t.v >= r.crit_threshold - r.recover_margin),
             count(*) filter (where t.v >= r.warn_threshold - r.recover_margin)
        into _nrec, _hc, _hw
        from (select (to_jsonb(m) ->> r.metric)::double precision as v from public.metrics m
               where m.cloud_server_id = c.id and m.ts >= _now - make_interval(mins => r.recover_minutes)) t;
      _rec_crit := _nrec >= ceil(r.recover_minutes * 0.6) and _hc = 0;
      _rec_warn := _nrec >= ceil(r.recover_minutes * 0.6) and _hw = 0;

      _new := _cur;
      if _cand is not null then
        if _new = 'critical' and _rec_crit then _new := 'warning'; end if;
        if _new = 'warning' and _rec_warn then _new := 'ok'; end if;
        if public._level_rank(_cand) > public._level_rank(_new) then _new := _cand; end if;
      end if;

      if _new is distinct from _cur or _since is null then _since := _now; end if;
      insert into public.alert_state as s (cloud_server_id, metric, level, level_since, updated_at)
      values (c.id, r.metric, _new, _since, _now)
      on conflict (cloud_server_id, metric) do update set level = excluded.level, level_since = excluded.level_since, updated_at = excluded.updated_at;

      if _new <> 'ok' then
        select (to_jsonb(m) ->> r.metric)::double precision into _val
          from public.metrics m where m.cloud_server_id = c.id order by m.ts desc limit 1;
        _reasons := _reasons || jsonb_build_object('metric', r.metric, 'level', _new, 'value', _val,
                      'warn', r.warn_threshold, 'crit', r.crit_threshold, 'since', _since);
        if _new = 'critical' then _crit_seen := true; else _warn_seen := true; end if;
      end if;
    end loop;

    -- Une règle désactivée ou supprimée ne laisse aucun niveau résiduel.
    delete from public.alert_state s where s.cloud_server_id = c.id and s.metric <> all (_active);

    _status := case when _crit_seen then 'critical' when _warn_seen then 'warning' else 'normal' end;
  end if;

  insert into public.cloud_status as s (cloud_server_id, workspace_id, status, status_since, detail, evaluated_at)
  values (c.id, c.workspace_id, _status, _now,
          jsonb_build_object('reasons', _reasons, 'connectivity', _conn, 'offline_diagnosis', _diag,
                             'last_agent_seen', _last_agent, 'metrics_received', st.last_received_at),
          _now)
  on conflict (cloud_server_id) do update set
    status = excluded.status,
    status_since = case when s.status is distinct from excluded.status then excluded.status_since else s.status_since end,
    detail = excluded.detail,
    evaluated_at = excluded.evaluated_at;
end;
$$;

create function public.evaluate_all()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  _c record;
  _n integer := 0;
  _errors integer := 0;
begin
  for _c in select id from public.cloud_servers loop
    begin
      perform public.evaluate_cloud(_c.id);
      _n := _n + 1;
    exception when others then
      _errors := _errors + 1;   -- un Cloud en erreur ne bloque jamais les autres
    end;
  end loop;
  insert into public.job_state (name, last_run_at, detail)
  values ('evaluate', now(), jsonb_build_object('clouds', _n, 'errors', _errors))
  on conflict (name) do update set last_run_at = excluded.last_run_at, detail = excluded.detail;
  return _n;
end;
$$;

-- Recalcul immédiat après un changement de seuils (sinon le prochain passage arrive dans la minute).
create function public.refresh_statuses()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  _c record;
  _n integer := 0;
begin
  for _c in select id from public.cloud_servers
             where public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]) loop
    perform public.evaluate_cloud(_c.id);
    _n := _n + 1;
  end loop;
  return _n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Aide au calibrage : distribution réelle de chaque métrique sur les derniers jours.
-- ---------------------------------------------------------------------------
create function public.get_metric_percentiles(_cloud_server_id uuid, _days integer default 7)
returns table (metric text, n integer, p50 double precision, p95 double precision, p99 double precision, max double precision)
language sql
stable
set search_path = ''
as $$
  select v.metric, count(v.val)::integer,
         percentile_cont(0.5) within group (order by v.val),
         percentile_cont(0.95) within group (order by v.val),
         percentile_cont(0.99) within group (order by v.val),
         max(v.val)
    from public.metrics m
   cross join lateral (values
      ('load1_per_core', m.load1_per_core::double precision), ('load5_per_core', m.load5_per_core::double precision),
      ('load1', m.load1::double precision), ('load5', m.load5::double precision), ('cpu_pct', m.cpu_pct::double precision),
      ('mem_used_pct', m.mem_used_pct::double precision), ('swap_used_pct', m.swap_used_pct::double precision),
      ('disk_used_pct', m.disk_used_pct::double precision)) as v(metric, val)
   where m.cloud_server_id = _cloud_server_id and m.ts >= now() - make_interval(days => least(greatest(_days, 1), 35))
   group by v.metric;
$$;

-- ---------------------------------------------------------------------------
-- Sondes HTTP (pg_net). Les deux fonctions « probe_http_* » isolent tout l'usage de pg_net.
-- Une réponse < 500 prouve que la couche web répond : seule une absence de réponse, un délai dépassé ou un 5xx est un échec.
-- ---------------------------------------------------------------------------
create function public.probe_http_get(_url text)
returns bigint language plpgsql security definer set search_path = '' as $$
begin
  return net.http_get(url := _url, timeout_milliseconds := 5000);
end;
$$;

create function public.probe_http_result(_request_id bigint)
returns table (status_code integer, timed_out boolean, error_msg text)
language plpgsql security definer set search_path = '' as $$
begin
  return query select r.status_code, coalesce(r.timed_out, false), r.error_msg from net._http_response r where r.id = _request_id;
end;
$$;

create function public.collect_probe_results()
returns integer language plpgsql set search_path = '' as $$
declare
  _p record;
  _res record;
  _n integer := 0;
begin
  for _p in select * from public.probe_requests loop
    select * into _res from public.probe_http_result(_p.request_id) limit 1;
    if found then
      insert into public.probe_results (web_hosting_id, ok, http_status, latency_ms, error)
      values (_p.web_hosting_id,
              not _res.timed_out and _res.error_msg is null and _res.status_code between 100 and 499,
              _res.status_code, (extract(epoch from (now() - _p.sent_at)) * 1000)::integer,
              nullif(left(coalesce(_res.error_msg, case when _res.timed_out then 'timeout' end), 200), ''));
      delete from public.probe_requests where request_id = _p.request_id;
      _n := _n + 1;
    elsif _p.sent_at < now() - interval '30 seconds' then
      insert into public.probe_results (web_hosting_id, ok, error) values (_p.web_hosting_id, false, 'pas de réponse');
      delete from public.probe_requests where request_id = _p.request_id;
      _n := _n + 1;
    end if;
  end loop;
  return _n;
end;
$$;

-- Envoie les sondes dues : toutes les 5 minutes en temps normal, chaque minute si l'agent de l'hébergement est en retard.
create function public.run_probes()
returns integer language plpgsql set search_path = '' as $$
declare
  _h record;
  _now timestamptz := now();
  _host text;
  _seen timestamptz;
  _last timestamptz;
  _every interval;
  _sent integer := 0;
  _err text;
begin
  perform public.collect_probe_results();
  begin
    for _h in select h.id, h.probe_url from public.web_hostings h
               where h.is_active and h.probe_url is not null loop
      _host := lower(substring(_h.probe_url from '^https://([^/:?#]+)'));
      -- Garde-fou : jamais d'adresse IP, de nom local ou de nom sans point.
      if _host is null or _host !~ '\.' or _host ~ '^[0-9.]+$' or _host ~ '(^localhost$|\.local$|\.internal$|\.localhost$)' then
        continue;
      end if;
      select hs.last_seen_at into _seen from public.web_hosting_state hs where hs.web_hosting_id = _h.id;
      _every := case when _seen is null or _seen < _now - interval '120 seconds' then interval '55 seconds' else interval '295 seconds' end;
      select greatest((select max(pr.ts) from public.probe_results pr where pr.web_hosting_id = _h.id),
                      (select max(rq.sent_at) from public.probe_requests rq where rq.web_hosting_id = _h.id)) into _last;
      if _last is null or _last <= _now - _every then
        insert into public.probe_requests (request_id, web_hosting_id) values (public.probe_http_get(_h.probe_url), _h.id);
        _sent := _sent + 1;
      end if;
    end loop;
  exception when others then
    get stacked diagnostics _err = message_text;   -- pg_net absent, par exemple : signalé dans job_state, jamais bloquant
  end;
  insert into public.job_state (name, last_run_at, detail)
  values ('probes', now(), jsonb_build_object('sent', _sent, 'error', _err))
  on conflict (name) do update set last_run_at = excluded.last_run_at, detail = excluded.detail;
  return _sent;
end;
$$;

-- ---------------------------------------------------------------------------
-- Purge : les résultats de sondes de plus de 14 jours s'ajoutent à la purge existante.
-- ---------------------------------------------------------------------------
create or replace function public.purge_old_data(_raw_days integer default 35, _hourly_days integer default 400)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  _raw integer;
  _hourly integer;
  _probes integer;
begin
  if _raw_days < 8 or _hourly_days < 35 then
    raise exception 'retention too short' using errcode = '22023';
  end if;
  delete from public.metrics where ts < now() - make_interval(days => _raw_days);
  get diagnostics _raw = row_count;
  delete from public.metrics_1h where ts < now() - make_interval(days => _hourly_days);
  get diagnostics _hourly = row_count;
  delete from public.probe_results where ts < now() - interval '14 days';
  get diagnostics _probes = row_count;

  insert into public.job_state (name, last_run_at, detail)
  values ('purge', now(), jsonb_build_object('raw_deleted', _raw, 'hourly_deleted', _hourly, 'probes_deleted', _probes))
  on conflict (name) do update set last_run_at = excluded.last_run_at, detail = excluded.detail;
  return jsonb_build_object('raw_deleted', _raw, 'hourly_deleted', _hourly, 'probes_deleted', _probes);
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------------
revoke all on function public._level_rank(text) from public, anon, authenticated;
revoke all on function public.evaluate_cloud(uuid) from public, anon, authenticated;
revoke all on function public.evaluate_all() from public, anon, authenticated;
revoke all on function public.collect_probe_results() from public, anon, authenticated;
revoke all on function public.run_probes() from public, anon, authenticated;
revoke all on function public.probe_http_get(text) from public, anon, authenticated;
revoke all on function public.probe_http_result(bigint) from public, anon, authenticated;
revoke all on function public.purge_old_data(integer, integer) from public, anon, authenticated;
revoke all on function public.refresh_statuses() from public, anon;
grant execute on function public.refresh_statuses() to authenticated;
revoke all on function public.get_metric_percentiles(uuid, integer) from public, anon;
grant execute on function public.get_metric_percentiles(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Planification : évaluation et sondes chaque minute (pg_cron, déjà actif ; pg_net pour les sondes).
-- Ne fait jamais échouer la migration.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    begin
      create extension if not exists pg_net;
    exception when others then
      raise notice 'pg_net non activable automatiquement : %', sqlerrm;
    end;
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.schedule('yellowscope-evaluate', '* * * * *', 'select public.evaluate_all()');
      perform cron.schedule('yellowscope-probes', '* * * * *', 'select public.run_probes()');
    exception when others then
      raise notice 'planification pg_cron impossible : %', sqlerrm;
    end;
  else
    raise notice 'pg_cron absent : les statuts ne seront pas recalculés automatiquement.';
  end if;
end;
$$;

select public.evaluate_all();
