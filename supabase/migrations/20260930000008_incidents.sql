-- Phase 6 : incidents et historique (aucune notification externe).
--
-- Un incident s'ouvre quand un Server Cloud sort de l'état normal et se referme quand le retour est STABLE :
--   NORMAL -> WARNING -> CRITICAL -> RETOUR (recovery) -> CLOS
-- Quatre types : performance (load, CPU, RAM, swap : un seul incident, jamais trois), disque, offline, agent.
-- Chaque changement est enregistré dans incident_events (chronologie).

-- ---------------------------------------------------------------------------
-- Réglages du workspace (clé / valeur). Aujourd'hui : délai de confirmation avant clôture d'un incident.
-- ---------------------------------------------------------------------------
create table public.settings (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  key          text not null check (key in ('incident_close_minutes')),
  value        jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, key),
  check (key <> 'incident_close_minutes' or (jsonb_typeof(value) = 'number' and (value #>> '{}')::numeric between 1 and 1440))
);

alter table public.settings enable row level security;
revoke all on public.settings from anon, authenticated;
grant select on public.settings to authenticated;
grant insert (workspace_id, key, value) on public.settings to authenticated;
grant update (value) on public.settings to authenticated;
create trigger settings_updated_at before update on public.settings
  for each row execute function public.set_updated_at();
create policy settings_select on public.settings for select to authenticated using (public.is_workspace_member(workspace_id));
create policy settings_insert on public.settings for insert to authenticated
  with check (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));
create policy settings_update on public.settings for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));

create function public.seed_settings(_workspace_id uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.settings (workspace_id, key, value) values (_workspace_id, 'incident_close_minutes', '5'::jsonb)
  on conflict (workspace_id, key) do nothing;
$$;
revoke all on function public.seed_settings(uuid) from public, anon, authenticated;

create or replace function public.workspaces_seed_alerts()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.seed_alert_defaults(new.id);
  perform public.seed_settings(new.id);
  return new;
end;
$$;

select public.seed_settings(id) from public.workspaces;

-- ---------------------------------------------------------------------------
-- Incidents et chronologie
-- ---------------------------------------------------------------------------
create table public.incidents (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  cloud_server_id uuid not null references public.cloud_servers (id) on delete cascade,
  web_hosting_id  uuid references public.web_hostings (id) on delete set null,   -- incidents « agent » uniquement
  kind            text not null check (kind in ('performance', 'disk', 'offline', 'agent')),
  status          text not null check (status in ('warning', 'critical', 'recovery', 'closed')),
  severity_max    text not null check (severity_max in ('warning', 'critical')),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,                    -- début du retour stable (la durée exclut le délai de confirmation)
  recovery_since  timestamptz,
  reasons         jsonb not null default '[]'::jsonb,   -- raisons courantes (métrique, valeur, seuils)
  peak            jsonb not null default '{}'::jsonb,   -- maximum observé par métrique pendant l'incident
  start_snapshot  jsonb,                                -- dernier relevé du Cloud à l'ouverture
  diagnosis       text,                                 -- diagnostic d'un silence (sondes), jamais une affirmation
  note            text check (char_length(note) <= 2000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Jamais deux incidents ouverts du même type pour le même Cloud (ou le même hébergement pour « agent »).
create unique index incidents_one_open on public.incidents
  (cloud_server_id, kind, coalesce(web_hosting_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status <> 'closed';
create index incidents_workspace_started_idx on public.incidents (workspace_id, started_at desc);
create index incidents_cloud_started_idx on public.incidents (cloud_server_id, started_at desc);

create trigger incidents_updated_at before update on public.incidents
  for each row execute function public.set_updated_at();

create table public.incident_events (
  id          bigint generated always as identity primary key,
  incident_id uuid not null references public.incidents (id) on delete cascade,
  ts          timestamptz not null default now(),
  type        text not null check (type in ('opened', 'escalated', 'deescalated', 'recovery_started', 'relapse', 'closed')),
  data        jsonb not null default '{}'::jsonb
);
create index incident_events_incident_idx on public.incident_events (incident_id, ts, id);

alter table public.incidents enable row level security;
alter table public.incident_events enable row level security;
revoke all on public.incidents, public.incident_events from anon, authenticated;
grant select on public.incidents, public.incident_events to authenticated;
grant update (note) on public.incidents to authenticated;   -- seule la note est modifiable par le client

create policy incidents_select on public.incidents for select to authenticated using (public.is_workspace_member(workspace_id));
create policy incidents_update_note on public.incidents for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));
create policy incident_events_select on public.incident_events for select to authenticated
  using (exists (select 1 from public.incidents i where i.id = incident_events.incident_id));

-- ---------------------------------------------------------------------------
-- Machine d'états d'un incident. _level : niveau courant de la catégorie (ok / warning / critical).
-- ---------------------------------------------------------------------------
create function public.sync_incident(
  _cloud_id uuid, _hosting_id uuid, _kind text, _level text, _reasons jsonb, _diag text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  _zero constant uuid := '00000000-0000-0000-0000-000000000000';
  _now timestamptz := now();
  c public.cloud_servers;
  i public.incidents;
  _close integer;
  _snap jsonb;
  _peak jsonb;
  _r jsonb;
  _v double precision;
  _from text;
begin
  select * into c from public.cloud_servers where id = _cloud_id;
  if not found then return; end if;

  _close := coalesce((select (s.value #>> '{}')::integer from public.settings s
                       where s.workspace_id = c.workspace_id and s.key = 'incident_close_minutes'), 5);
  select * into i from public.incidents
   where cloud_server_id = _cloud_id and kind = _kind
     and coalesce(web_hosting_id, _zero) = coalesce(_hosting_id, _zero) and status <> 'closed'
   for update;

  if not found then
    if _level = 'ok' then return; end if;
    select st.last_point into _snap from public.cloud_server_state st where st.cloud_server_id = _cloud_id;
    _peak := '{}'::jsonb;
    for _r in select value from jsonb_array_elements(_reasons) loop
      if _r ? 'metric' and jsonb_typeof(_r -> 'value') = 'number' then
        _peak := jsonb_set(_peak, array[_r ->> 'metric'], _r -> 'value');
      end if;
    end loop;
    insert into public.incidents (workspace_id, cloud_server_id, web_hosting_id, kind, status, severity_max, started_at,
                                  reasons, peak, start_snapshot, diagnosis)
    values (c.workspace_id, _cloud_id, _hosting_id, _kind, _level, _level, _now, _reasons, _peak, _snap, _diag)
    returning * into i;
    insert into public.incident_events (incident_id, ts, type, data)
    values (i.id, _now, 'opened', jsonb_build_object('level', _level, 'reasons', _reasons, 'diagnosis', _diag));
    return;
  end if;

  if _level = 'ok' then
    if i.status <> 'recovery' then
      update public.incidents set status = 'recovery', recovery_since = _now where id = i.id;
      insert into public.incident_events (incident_id, ts, type, data) values (i.id, _now, 'recovery_started', '{}'::jsonb);
    elsif i.recovery_since <= _now - make_interval(mins => _close) then
      update public.incidents set status = 'closed', ended_at = i.recovery_since where id = i.id;
      insert into public.incident_events (incident_id, ts, type, data)
      values (i.id, _now, 'closed', jsonb_build_object('duration_seconds', extract(epoch from (i.recovery_since - i.started_at))::integer));
    end if;
    return;
  end if;

  -- Le niveau n'est pas « ok » : rechute, escalade ou désescalade (historique seulement, sans notification).
  _peak := i.peak;
  for _r in select value from jsonb_array_elements(_reasons) loop
    if _r ? 'metric' and jsonb_typeof(_r -> 'value') = 'number' then
      _v := (_r ->> 'value')::double precision;
      if not (_peak ? (_r ->> 'metric')) or _v > (_peak ->> (_r ->> 'metric'))::double precision then
        _peak := jsonb_set(_peak, array[_r ->> 'metric'], _r -> 'value');
      end if;
    end if;
  end loop;

  _from := i.status;
  if i.status = 'recovery' then
    update public.incidents set status = _level, recovery_since = null where id = i.id;
    insert into public.incident_events (incident_id, ts, type, data) values (i.id, _now, 'relapse', jsonb_build_object('level', _level));
  elsif public._level_rank(_level) > public._level_rank(i.status) then
    update public.incidents set status = _level where id = i.id;
    insert into public.incident_events (incident_id, ts, type, data)
    values (i.id, _now, 'escalated', jsonb_build_object('from', _from, 'to', _level, 'reasons', _reasons));
  elsif public._level_rank(_level) < public._level_rank(i.status) then
    update public.incidents set status = _level where id = i.id;
    insert into public.incident_events (incident_id, ts, type, data)
    values (i.id, _now, 'deescalated', jsonb_build_object('from', _from, 'to', _level));
  end if;

  update public.incidents
     set severity_max = case when public._level_rank(_level) > public._level_rank(severity_max) then _level else severity_max end,
         reasons = _reasons, peak = _peak, diagnosis = coalesce(_diag, diagnosis)
   where id = i.id;
end;
$$;
revoke all on function public.sync_incident(uuid, uuid, text, text, jsonb, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Évaluation d'un Cloud (remplace celle de la phase 5) : mêmes règles, plus la synchronisation des incidents.
-- ---------------------------------------------------------------------------
create or replace function public.evaluate_cloud(_cloud_id uuid)
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
  _perf_level text := 'ok'; _disk_level text := 'ok';
  _perf_reasons jsonb := '[]'::jsonb; _disk_reasons jsonb := '[]'::jsonb;
  _evaluated boolean := false;
  _reason jsonb; _hreasons jsonb; _l text; _h record;
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
        _reason := jsonb_build_object('metric', r.metric, 'level', _new, 'value', _val,
                      'warn', r.warn_threshold, 'crit', r.crit_threshold, 'since', _since);
        _reasons := _reasons || _reason;
        -- Load, CPU, RAM et swap alimentent UN incident « performance » ; le disque a le sien (évolution lente).
        if r.metric = 'disk_used_pct' then
          _disk_reasons := _disk_reasons || _reason;
          if public._level_rank(_new) > public._level_rank(_disk_level) then _disk_level := _new; end if;
        else
          _perf_reasons := _perf_reasons || _reason;
          if public._level_rank(_new) > public._level_rank(_perf_level) then _perf_level := _new; end if;
        end if;
        if _new = 'critical' then _crit_seen := true; else _warn_seen := true; end if;
      end if;
    end loop;

    -- Une règle désactivée ou supprimée ne laisse aucun niveau résiduel.
    delete from public.alert_state s where s.cloud_server_id = c.id and s.metric <> all (_active);

    _status := case when _crit_seen then 'critical' when _warn_seen then 'warning' else 'normal' end;
    _evaluated := true;
  end if;

  -- 3. Incidents : ouverture, escalade, retour, clôture (aucune notification). En maintenance, rien ne bouge.
  if _status <> 'maintenance' then
    if _evaluated then
      perform public.sync_incident(c.id, null, 'performance', _perf_level, _perf_reasons, null);
      perform public.sync_incident(c.id, null, 'disk', _disk_level, _disk_reasons, null);
    end if;
    if _last_agent is not null then
      perform public.sync_incident(c.id, null, 'offline', case when _alive then 'ok' else 'critical' end, '[]'::jsonb, _diag);
    end if;
    -- Agents individuels, seulement si le Cloud est vivant (sinon l'incident « offline » couvre déjà tout).
    if _alive then
      for _h in
        select h.id, h.is_active, h.system_metrics_collector, hs.last_seen_at
          from public.web_hostings h join public.web_hosting_state hs on hs.web_hosting_id = h.id
         where h.cloud_server_id = c.id
      loop
        _l := 'ok'; _hreasons := '[]'::jsonb;
        if _h.is_active then
          if _h.last_seen_at < _now - _offline then
            _l := 'warning';
            _hreasons := jsonb_build_array(jsonb_build_object('kind', 'silent', 'last_seen', _h.last_seen_at));
          elsif _h.system_metrics_collector and not _fresh then
            _l := 'warning';
            _hreasons := jsonb_build_array(jsonb_build_object('kind', 'metrics_stale'));
          end if;
        end if;
        perform public.sync_incident(c.id, _h.id, 'agent', _l, _hreasons, null);
      end loop;
    end if;
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

-- ---------------------------------------------------------------------------
-- Séries sur une fenêtre arbitraire (période d'un incident) : au plus ~700 points.
--   fenêtre de moins de ~12 h : relevés d'1 minute ; au-delà : tranches regroupées ; avant 34 jours : agrégats horaires.
-- ---------------------------------------------------------------------------
create function public.get_series_window(_cloud_server_id uuid, _from timestamptz, _to timestamptz)
returns table (
  ts timestamptz, n integer,
  load1_avg real, load1_max real, load5_avg real, load15_avg real,
  cpu_pct_avg real, cpu_pct_max real,
  mem_used_pct_avg real, mem_used_pct_max real,
  swap_used_pct_avg real, swap_used_pct_max real,
  disk_used_pct_avg real, disk_used_pct_max real
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  _origin constant timestamptz := timestamptz '2000-01-01 00:00:00+00';
  _step_min integer;
  _step interval;
begin
  if _to <= _from or _to - _from > interval '400 days' then
    raise exception 'invalid window' using errcode = '22023';
  end if;

  if _from < now() - interval '34 days' then
    return query
      select h.ts, h.n, h.load1_avg, h.load1_max, h.load5_avg, h.load15_avg, h.cpu_pct_avg, h.cpu_pct_max,
             h.mem_used_pct_avg, h.mem_used_pct_max, h.swap_used_pct_avg, h.swap_used_pct_max,
             h.disk_used_pct_avg, h.disk_used_pct_max
        from public.metrics_1h h
       where h.cloud_server_id = _cloud_server_id and h.ts >= date_bin(interval '1 hour', _from, _origin) and h.ts < _to
       order by h.ts;
    return;
  end if;

  _step_min := greatest(1, ceil(extract(epoch from (_to - _from)) / 60.0 / 700.0)::integer);
  if _step_min = 1 then
    return query
      select m.ts, 1, m.load1, m.load1, m.load5, m.load15, m.cpu_pct, m.cpu_pct,
             m.mem_used_pct, m.mem_used_pct, m.swap_used_pct, m.swap_used_pct, m.disk_used_pct, m.disk_used_pct
        from public.metrics m
       where m.cloud_server_id = _cloud_server_id and m.ts >= _from and m.ts < _to
       order by m.ts;
  else
    _step := make_interval(mins => _step_min);
    return query
      select date_bin(_step, m.ts, _origin), count(*)::integer,
             avg(m.load1)::real, max(m.load1), avg(m.load5)::real, avg(m.load15)::real,
             avg(m.cpu_pct)::real, max(m.cpu_pct),
             avg(m.mem_used_pct)::real, max(m.mem_used_pct),
             avg(m.swap_used_pct)::real, max(m.swap_used_pct),
             avg(m.disk_used_pct)::real, max(m.disk_used_pct)
        from public.metrics m
       where m.cloud_server_id = _cloud_server_id and m.ts >= _from and m.ts < _to
       group by 1
       order by 1;
  end if;
end;
$$;
revoke all on function public.get_series_window(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_series_window(uuid, timestamptz, timestamptz) to authenticated;
