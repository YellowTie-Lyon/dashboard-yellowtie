-- Phase 10 : notifications Slack (Incoming Webhook).
--
-- Principe : chaque changement d'un incident (incident_events) peut produire un message Slack. Le message est composé au moment de
-- l'événement (avec les domaines les plus sollicités à cet instant), mis dans une file (notification_outbox) puis envoyé par
-- pg_cron toutes les minutes via pg_net, avec 3 tentatives. L'adresse du webhook est un SECRET : elle n'est lisible par aucun client
-- (droits de colonne) et ne se modifie que par la RPC réservée aux propriétaires.
--
-- Règles : alerte à l'ouverture / l'escalade / la rechute si le niveau atteint le seuil choisi (Warning ou Critical) ;
-- message « retour à la normale » à la clôture seulement si une alerte avait été envoyée ; rappel périodique tant qu'un incident
-- reste Critical (0 = jamais) ; rien en mode maintenance (les incidents y sont gelés).

-- ---------------------------------------------------------------------------
-- Réglages (une ligne par workspace)
-- ---------------------------------------------------------------------------
create table public.notification_settings (
  workspace_id     uuid primary key references public.workspaces (id) on delete cascade,
  slack_webhook_url text check (slack_webhook_url is null or slack_webhook_url ~ '^https://hooks\.slack\.com/services/[A-Za-z0-9_/-]{10,200}$'),
  enabled          boolean not null default false,
  min_level        text not null default 'critical' check (min_level in ('warning', 'critical')),
  notify_recovery  boolean not null default true,
  reminder_minutes integer not null default 30 check (reminder_minutes in (0, 15, 30, 60, 120)),
  site_url         text check (site_url is null or site_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$'),
  has_webhook      boolean generated always as (slack_webhook_url is not null) stored,
  webhook_hint     text generated always as (right(slack_webhook_url, 4)) stored,
  updated_at       timestamptz not null default now()
);

alter table public.notification_settings enable row level security;
revoke all on public.notification_settings from anon, authenticated;
-- Droits PAR COLONNE : l'adresse du webhook (slack_webhook_url) n'est jamais lisible par le client.
grant select (workspace_id, enabled, min_level, notify_recovery, reminder_minutes, site_url, has_webhook, webhook_hint, updated_at)
  on public.notification_settings to authenticated;
create policy notification_settings_select on public.notification_settings
  for select to authenticated using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- File d'envoi et historique
-- ---------------------------------------------------------------------------
create table public.notification_outbox (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  incident_id  uuid references public.incidents (id) on delete set null,
  kind         text not null check (kind in ('alert', 'recovery', 'reminder', 'test')),
  summary      text not null,
  payload      jsonb not null,
  status       text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts     integer not null default 0,
  request_id   bigint,
  last_error   text,
  created_at   timestamptz not null default now(),
  next_try_at  timestamptz not null default now(),
  sent_at      timestamptz
);
create index notification_outbox_queue_idx on public.notification_outbox (status, next_try_at);
create index notification_outbox_incident_idx on public.notification_outbox (incident_id, created_at);

alter table public.notification_outbox enable row level security;
revoke all on public.notification_outbox from anon, authenticated;
grant select (id, workspace_id, incident_id, kind, summary, status, attempts, last_error, created_at, sent_at)
  on public.notification_outbox to authenticated;
create policy notification_outbox_select on public.notification_outbox
  for select to authenticated using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- pg_net : tout l'usage est isolé dans ces deux fonctions (une absence de l'extension est signalée dans job_state, jamais bloquante)
-- ---------------------------------------------------------------------------
create function public.notify_http_post(_url text, _body jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
begin
  return net.http_post(url := _url, body := _body, headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 8000);
end;
$$;

create function public.notify_http_result(_request_id bigint)
returns table (status_code integer, timed_out boolean, error_msg text)
language plpgsql security definer set search_path = '' as $$
begin
  return query select r.status_code, coalesce(r.timed_out, false), r.error_msg from net._http_response r where r.id = _request_id;
end;
$$;
revoke all on function public.notify_http_post(text, jsonb) from public, anon, authenticated;
revoke all on function public.notify_http_result(bigint) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- L'événement « rechute » embarque désormais les raisons courantes (le message Slack les affiche).
-- ---------------------------------------------------------------------------
create or replace function public.sync_incident(
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
    insert into public.incident_events (incident_id, ts, type, data) values (i.id, _now, 'relapse', jsonb_build_object('level', _level, 'reasons', _reasons));
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

-- ---------------------------------------------------------------------------
-- Composition des messages
-- ---------------------------------------------------------------------------
create function public.notify_esc(_t text)
returns text language sql immutable set search_path = '' as $$
  select replace(replace(replace(coalesce(_t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
$$;

create function public.notify_duration(_seconds integer)
returns text language sql immutable set search_path = '' as $$
  select case
    when _seconds is null then 'inconnue'
    when _seconds < 60 then _seconds || ' s'
    when _seconds < 3600 then (_seconds / 60) || ' min'
    else (_seconds / 3600) || ' h ' || lpad(((_seconds % 3600) / 60)::text, 2, '0') || ' min'
  end;
$$;

-- Une ligne lisible pour une raison d'incident : « • CPU : 92 % (Critical, seuil 90 %) ».
create function public.notify_reason_text(_r jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare
  _m text := _r ->> 'metric';
  _v numeric := nullif(_r ->> 'value', '')::numeric;
  _thr numeric := case when _r ->> 'level' = 'critical' then nullif(_r ->> 'crit', '')::numeric else nullif(_r ->> 'warn', '')::numeric end;
  _label text;
  _pct boolean := _m like '%\_pct';
begin
  if _m is null then return null; end if;
  _label := case _m
    when 'cpu_pct' then 'CPU' when 'mem_used_pct' then 'RAM' when 'disk_used_pct' then 'Disque' when 'swap_used_pct' then 'Swap'
    when 'load1_per_core' then 'Load 1 min par cœur' when 'load5_per_core' then 'Load 5 min par cœur'
    when 'load1' then 'Load 1 min' when 'load5' then 'Load 5 min' else _m end;
  return '• ' || _label || ' : ' || coalesce(replace(trim_scale(round(_v, case when _pct then 1 else 2 end))::text, '.', ','), '—') || case when _pct then ' %' else '' end
      || ' (' || case when _r ->> 'level' = 'critical' then 'Critical' else 'Warning' end
      || coalesce(', seuil ' || replace(trim_scale(_thr)::text, '.', ',') || case when _pct then ' %' else '' end, '') || ')';
end;
$$;

-- Message Slack complet (attachments + blocs) pour un incident. _kind : alert | recovery | reminder.
create function public.compose_incident_notification(_incident_id uuid, _kind text, _level text, _event jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  i public.incidents;
  _cloud text;
  _hosting text;
  _site text;
  _type text;
  _emoji text;
  _color text;
  _title text;
  _lines text := '';
  _r jsonb;
  _traffic text;
  _t jsonb;
  _detail text;
  _url text;
  _blocks jsonb;
begin
  select * into i from public.incidents where id = _incident_id;
  select name into _cloud from public.cloud_servers where id = i.cloud_server_id;
  select name into _hosting from public.web_hostings where id = i.web_hosting_id;
  select site_url into _site from public.notification_settings where workspace_id = i.workspace_id;
  _type := case i.kind when 'performance' then 'Performance' when 'disk' then 'Disque' when 'offline' then 'Cloud hors ligne' else 'Agent' end;

  if _kind = 'recovery' then
    _emoji := '✅'; _color := '#22c55e'; _title := 'Retour à la normale';
    _detail := 'Incident *' || _type || '* clos. Durée : ' || public.notify_duration(nullif(_event ->> 'duration_seconds', '')::integer) || '.';
  else
    _emoji := case when _level = 'critical' then '🔴' else '🟠' end;
    _color := case when _level = 'critical' then '#dc2626' else '#f59e0b' end;
    _title := case when _kind = 'reminder' then 'Toujours en ' else '' end || case when _level = 'critical' then 'Critical' else 'Warning' end;

    if i.kind = 'agent' then
      _detail := '*Agent' || coalesce(' · ' || public.notify_esc(_hosting), '') || '* : '
        || case when i.reasons -> 0 ->> 'kind' = 'metrics_stale' then 'le collecteur répond mais n''envoie plus de relevés.' else 'l''agent n''envoie plus de données alors que le Cloud répond.' end;
    else
      -- Les raisons de l'événement sont les plus récentes (l'incident n'est mis à jour qu'après l'insertion de l'événement).
      for _r in select value from jsonb_array_elements(case when jsonb_typeof(_event -> 'reasons') = 'array' then _event -> 'reasons' else i.reasons end) loop
        if public.notify_reason_text(_r) is not null then _lines := _lines || E'\n' || public.notify_esc(public.notify_reason_text(_r)); end if;
      end loop;
      _detail := '*' || _type || '*' || _lines;
      if i.kind = 'offline' then
        _detail := _detail || E'\n' || case i.diagnosis
          when 'agents_silent' then 'Agents silencieux, les sondes répondent : le serveur web répond probablement.'
          when 'unreachable_probable' then 'Aucun agent ne répond et les sondes échouent : Cloud potentiellement inaccessible.'
          else 'Aucun agent ne répond.' end;
      end if;
    end if;

    -- Domaines les plus sollicités sur les 15 dernières minutes : « potentiellement impliqués », jamais une cause.
    if i.kind in ('performance', 'disk') then
      _t := public.compute_incident_traffic(i.cloud_server_id, now() - interval '15 minutes', now());
      if coalesce((_t ->> 'requests')::bigint, 0) > 0 then
        select string_agg(public.notify_esc(d ->> 'domain') || ' (' || replace(trim_scale((d ->> 'share')::numeric)::text, '.', ',') || ' %)', ', ' order by ord)
          into _traffic
          from jsonb_array_elements(_t -> 'domains') with ordinality x(d, ord) where ord <= 3;
        if _traffic is not null then
          _detail := _detail || E'\n\n_Domaines les plus sollicités (15 min), potentiellement impliqués :_ ' || _traffic;
        end if;
      end if;
    end if;
  end if;

  _url := case when _site is not null then _site || '/incidents/' || i.id end;
  _blocks := jsonb_build_array(
    jsonb_build_object('type', 'header', 'text', jsonb_build_object('type', 'plain_text', 'text', left(_emoji || ' ' || _title || ' · ' || coalesce(_cloud, 'Server Cloud'), 150), 'emoji', true)),
    jsonb_build_object('type', 'section', 'text', jsonb_build_object('type', 'mrkdwn', 'text', left(_detail, 2800))),
    jsonb_build_object('type', 'context', 'elements', jsonb_build_array(jsonb_build_object('type', 'mrkdwn',
      'text', 'Ouvert le ' || to_char(i.started_at at time zone 'Europe/Paris', 'DD/MM à HH24:MI') || ' · YellowScope')))
  );
  if _url is not null then
    _blocks := _blocks || jsonb_build_array(jsonb_build_object('type', 'actions', 'elements', jsonb_build_array(
      jsonb_build_object('type', 'button', 'text', jsonb_build_object('type', 'plain_text', 'text', 'Voir l''incident'), 'url', _url))));
  end if;

  return jsonb_build_object(
    'text', _emoji || ' ' || _title || ' · ' || coalesce(_cloud, 'Server Cloud') || ' (' || _type || ')',
    'attachments', jsonb_build_array(jsonb_build_object('color', _color, 'blocks', _blocks))
  );
end;
$$;
revoke all on function public.compose_incident_notification(uuid, text, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- File d'attente alimentée par les événements d'incident
-- ---------------------------------------------------------------------------
create function public.notify_on_incident_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.incidents;
  s public.notification_settings;
  _level text;
  _kind text;
  _msg jsonb;
begin
  select * into i from public.incidents where id = new.incident_id;
  select * into s from public.notification_settings where workspace_id = i.workspace_id;
  if not found or not s.enabled or s.slack_webhook_url is null then return new; end if;

  if new.type in ('opened', 'escalated', 'relapse') then
    _level := case new.type when 'escalated' then new.data ->> 'to' else new.data ->> 'level' end;
    if _level is null or public._level_rank(_level) < public._level_rank(s.min_level) then return new; end if;
    _kind := 'alert';
  elsif new.type = 'closed' and s.notify_recovery then
    -- Un « retour à la normale » n'a de sens que si une alerte avait été envoyée pour cet incident.
    if not exists (select 1 from public.notification_outbox o where o.incident_id = i.id and o.kind = 'alert') then return new; end if;
    _kind := 'recovery';
  else
    return new;
  end if;

  _msg := public.compose_incident_notification(i.id, _kind, _level, new.data);
  insert into public.notification_outbox (workspace_id, incident_id, kind, summary, payload)
  values (i.workspace_id, i.id, _kind, left(_msg ->> 'text', 300), _msg);
  return new;
exception when others then
  return new;   -- une notification ne doit JAMAIS empêcher l'enregistrement d'un incident
end;
$$;
revoke all on function public.notify_on_incident_event() from public, anon, authenticated;

create trigger incident_events_notify
  after insert on public.incident_events
  for each row execute function public.notify_on_incident_event();

-- ---------------------------------------------------------------------------
-- Envoi (pg_cron, chaque minute) : réponses reçues, rappels, envois dus, purge
-- ---------------------------------------------------------------------------
create function public.dispatch_notifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  _sent integer := 0;
  _row record;
  _res record;
  _rid bigint;
  _err text;
  _reason text;
  _msg jsonb;
begin
  begin
    -- 1. Réponses de Slack pour les envois en cours.
    for _row in select * from public.notification_outbox where status = 'sending' loop
      select * into _res from public.notify_http_result(_row.request_id) limit 1;
      if found then
        if not _res.timed_out and _res.error_msg is null and _res.status_code between 200 and 299 then
          update public.notification_outbox set status = 'sent', sent_at = now(), last_error = null where id = _row.id;
        else
          _reason := left(coalesce(_res.error_msg, case when _res.timed_out then 'délai dépassé' end, 'HTTP ' || _res.status_code), 200);
          update public.notification_outbox
             set status = case when attempts < 3 then 'pending' else 'failed' end,
                 next_try_at = now() + make_interval(mins => attempts * 2), last_error = _reason
           where id = _row.id;
        end if;
      elsif _row.next_try_at < now() - interval '2 minutes' then
        update public.notification_outbox
           set status = case when attempts < 3 then 'pending' else 'failed' end,
               next_try_at = now() + make_interval(mins => attempts * 2), last_error = 'pas de réponse'
         where id = _row.id;
      end if;
    end loop;

    -- 2. Rappels : incident toujours Critical, déjà notifié, dernier message plus ancien que le délai choisi.
    for _row in
      select i.id as incident_id, i.workspace_id
        from public.incidents i
        join public.notification_settings s on s.workspace_id = i.workspace_id
       where i.status = 'critical' and s.enabled and s.slack_webhook_url is not null and s.reminder_minutes > 0
         and exists (select 1 from public.notification_outbox o where o.incident_id = i.id and o.kind = 'alert')
         and (select max(o.created_at) from public.notification_outbox o where o.incident_id = i.id and o.kind in ('alert', 'reminder'))
             <= now() - make_interval(mins => s.reminder_minutes)
    loop
      _msg := public.compose_incident_notification(_row.incident_id, 'reminder', 'critical');
      insert into public.notification_outbox (workspace_id, incident_id, kind, summary, payload)
      values (_row.workspace_id, _row.incident_id, 'reminder', left(_msg ->> 'text', 300), _msg);
    end loop;

    -- 3. Envois dus.
    for _row in
      select o.id, o.payload, s.slack_webhook_url
        from public.notification_outbox o
        left join public.notification_settings s on s.workspace_id = o.workspace_id
       where o.status = 'pending' and o.next_try_at <= now()
       order by o.id limit 20
       for update of o skip locked
    loop
      if _row.slack_webhook_url is null then
        update public.notification_outbox set status = 'failed', last_error = 'adresse du webhook Slack non configurée' where id = _row.id;
      else
        _rid := public.notify_http_post(_row.slack_webhook_url, _row.payload);
        update public.notification_outbox set status = 'sending', attempts = attempts + 1, request_id = _rid, next_try_at = now() where id = _row.id;
        _sent := _sent + 1;
      end if;
    end loop;

    delete from public.notification_outbox where created_at < now() - interval '14 days';
  exception when others then
    get stacked diagnostics _err = message_text;   -- pg_net absent, par exemple : signalé dans job_state
  end;

  insert into public.job_state (name, last_run_at, detail)
  values ('notify', now(), jsonb_build_object('sent', _sent, 'error', _err))
  on conflict (name) do update set last_run_at = excluded.last_run_at, detail = excluded.detail;
  return _sent;
end;
$$;
revoke all on function public.dispatch_notifications() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPC (propriétaires, session aal2)
-- ---------------------------------------------------------------------------
create function public.save_notification_settings(
  _webhook_url text, _enabled boolean, _min_level text, _notify_recovery boolean, _reminder_minutes integer, _site_url text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _ws uuid;
begin
  select m.workspace_id into _ws from public.workspace_members m where m.user_id = auth.uid() and m.role = 'owner' limit 1;
  if _ws is null or not public.is_aal2() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.notification_settings as s (workspace_id, slack_webhook_url, enabled, min_level, notify_recovery, reminder_minutes, site_url)
  values (_ws, nullif(btrim(_webhook_url), ''), _enabled and nullif(btrim(_webhook_url), '') is not null, _min_level, _notify_recovery, _reminder_minutes, _site_url)
  on conflict (workspace_id) do update set
    -- null = conserver l'adresse actuelle ; chaîne vide = la supprimer (et désactiver).
    slack_webhook_url = case when _webhook_url is null then s.slack_webhook_url else nullif(btrim(_webhook_url), '') end,
    enabled = _enabled and (case when _webhook_url is null then s.slack_webhook_url else nullif(btrim(_webhook_url), '') end) is not null,
    min_level = excluded.min_level, notify_recovery = excluded.notify_recovery,
    reminder_minutes = excluded.reminder_minutes, site_url = coalesce(excluded.site_url, s.site_url), updated_at = now();
  perform public.write_audit(_ws, 'notifications.settings_saved', 'notification_settings', null,
                             jsonb_build_object('enabled', _enabled, 'min_level', _min_level, 'webhook_changed', _webhook_url is not null));
end;
$$;
revoke all on function public.save_notification_settings(text, boolean, text, boolean, integer, text) from public, anon;
grant execute on function public.save_notification_settings(text, boolean, text, boolean, integer, text) to authenticated;

create function public.send_test_notification()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  _ws uuid;
  _id bigint;
  _site text;
  _msg jsonb;
begin
  select m.workspace_id into _ws from public.workspace_members m where m.user_id = auth.uid() and m.role = 'owner' limit 1;
  if _ws is null or not public.is_aal2() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select site_url into _site from public.notification_settings where workspace_id = _ws and slack_webhook_url is not null;
  if not found then
    raise exception 'webhook not configured' using errcode = '22023';
  end if;
  _msg := jsonb_build_object(
    'text', '🔔 Test de notification YellowScope',
    'attachments', jsonb_build_array(jsonb_build_object('color', '#ffc629', 'blocks', jsonb_build_array(
      jsonb_build_object('type', 'header', 'text', jsonb_build_object('type', 'plain_text', 'text', '🔔 Test de notification', 'emoji', true)),
      jsonb_build_object('type', 'section', 'text', jsonb_build_object('type', 'mrkdwn',
        'text', 'Si vous lisez ce message, les alertes YellowScope arriveront bien dans ce canal.'))))));
  insert into public.notification_outbox (workspace_id, kind, summary, payload)
  values (_ws, 'test', 'Test de notification', _msg) returning id into _id;
  perform public.dispatch_notifications();
  return _id;
end;
$$;
revoke all on function public.send_test_notification() from public, anon;
grant execute on function public.send_test_notification() to authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.schedule('yellowscope-notify', '* * * * *', 'select public.dispatch_notifications()');
    exception when others then
      raise notice 'planification pg_cron des notifications impossible : %', sqlerrm;
    end;
  end if;
end;
$$;
