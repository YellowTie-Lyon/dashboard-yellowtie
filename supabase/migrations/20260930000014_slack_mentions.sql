-- Phase 10 (suite) : mention Slack. L'alerte peut « pinguer » le salon (@here, @channel), une personne ou un groupe.
--
-- La mention est placée dans le texte principal du message (c'est lui qui déclenche la notification Slack). Elle s'applique aux
-- alertes et rappels Critical (et aux Warning si l'option est cochée), jamais au retour à la normale ; le message de test la
-- contient pour vérifier qu'elle fonctionne.

alter table public.notification_settings
  add column mention text check (mention is null or mention ~ '^(<!here>|<!channel>|<@[UW][A-Z0-9]{6,15}>|<!subteam\^S[A-Z0-9]{6,15}>)( (<!here>|<!channel>|<@[UW][A-Z0-9]{6,15}>|<!subteam\^S[A-Z0-9]{6,15}>)){0,2}$'),
  add column mention_warning boolean not null default false;

grant select (mention, mention_warning) on public.notification_settings to authenticated;

drop function public.save_notification_settings(text, boolean, text, boolean, integer, text);
create function public.save_notification_settings(
  _webhook_url text, _enabled boolean, _min_level text, _notify_recovery boolean, _reminder_minutes integer, _site_url text,
  _mention text default null, _mention_warning boolean default false
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
  insert into public.notification_settings as s
    (workspace_id, slack_webhook_url, enabled, min_level, notify_recovery, reminder_minutes, site_url, mention, mention_warning)
  values (_ws, nullif(btrim(_webhook_url), ''), _enabled and nullif(btrim(_webhook_url), '') is not null, _min_level, _notify_recovery,
          _reminder_minutes, _site_url, nullif(btrim(_mention), ''), _mention_warning)
  on conflict (workspace_id) do update set
    -- null = conserver la valeur actuelle ; chaîne vide = la supprimer.
    slack_webhook_url = case when _webhook_url is null then s.slack_webhook_url else nullif(btrim(_webhook_url), '') end,
    enabled = _enabled and (case when _webhook_url is null then s.slack_webhook_url else nullif(btrim(_webhook_url), '') end) is not null,
    min_level = excluded.min_level, notify_recovery = excluded.notify_recovery,
    reminder_minutes = excluded.reminder_minutes, site_url = coalesce(excluded.site_url, s.site_url),
    mention = case when _mention is null then s.mention else nullif(btrim(_mention), '') end,
    mention_warning = excluded.mention_warning, updated_at = now();
  perform public.write_audit(_ws, 'notifications.settings_saved', 'notification_settings', null,
                             jsonb_build_object('enabled', _enabled, 'min_level', _min_level, 'webhook_changed', _webhook_url is not null));
end;
$$;
revoke all on function public.save_notification_settings(text, boolean, text, boolean, integer, text, text, boolean) from public, anon;
grant execute on function public.save_notification_settings(text, boolean, text, boolean, integer, text, text, boolean) to authenticated;

create or replace function public.compose_incident_notification(_incident_id uuid, _kind text, _level text, _event jsonb default '{}'::jsonb)
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
  _mention text;
begin
  select * into i from public.incidents where id = _incident_id;
  select name into _cloud from public.cloud_servers where id = i.cloud_server_id;
  select name into _hosting from public.web_hostings where id = i.web_hosting_id;
  select site_url,
         case when _kind in ('alert', 'reminder') and (_level = 'critical' or mention_warning) then mention end
    into _site, _mention
    from public.notification_settings where workspace_id = i.workspace_id;
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
    -- La mention est dans le texte PRINCIPAL du message : c'est lui qui déclenche la notification Slack (@here, @channel, personne, groupe).
    'text', coalesce(_mention || ' ', '') || _emoji || ' ' || _title || ' · ' || coalesce(_cloud, 'Server Cloud') || ' (' || _type || ')',
    'attachments', jsonb_build_array(jsonb_build_object('color', _color, 'blocks', _blocks))
  );
end;
$$;

-- Le résumé de l'historique ne doit pas répéter la mention : on le calcule sur le texte sans elle.
create or replace function public.notify_summary(_text text)
returns text language sql immutable set search_path = '' as $$
  select left(regexp_replace(coalesce(_text, ''), '^(<[!@][^>]+> )+', ''), 300);
$$;

create or replace function public.notify_on_incident_event()
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
  values (i.workspace_id, i.id, _kind, public.notify_summary(_msg ->> 'text'), _msg);
  return new;
exception when others then
  return new;   -- une notification ne doit JAMAIS empêcher l'enregistrement d'un incident
end;
$$;

create or replace function public.dispatch_notifications()
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
      values (_row.workspace_id, _row.incident_id, 'reminder', public.notify_summary(_msg ->> 'text'), _msg);
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


-- ---------------------------------------------------------------------------
-- Messages de test : un exemple de CHAQUE notification, tel qu'il arrivera (mêmes couleurs, mêmes mentions, mêmes boutons),
-- avec des données fictives et la marque [TEST]. Types : basic, critical, warning, reminder, recovery, offline, agent.
-- ---------------------------------------------------------------------------
create function public.notify_sample_message(_type text, _mention text, _mention_warning boolean, _site text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  _emoji text; _color text; _title text; _detail text; _ping text := null; _blocks jsonb;
  _traffic constant text := E'\n\n_Domaines les plus sollicités (15 min), potentiellement impliqués :_ boutique-exemple.fr (46 %), agence-exemple.fr (20 %), restaurant-exemple.fr (13 %)';
begin
  case _type
    when 'critical' then
      _emoji := '🔴'; _color := '#dc2626'; _title := 'Critical';
      _detail := E'*Performance*\n• CPU : 92,4 % (Critical, seuil 90 %)\n• Load 1 min par cœur : 1,08 (Critical, seuil 1)' || _traffic; _ping := _mention;
    when 'warning' then
      _emoji := '🟠'; _color := '#f59e0b'; _title := 'Warning';
      _detail := E'*Performance*\n• CPU : 78,2 % (Warning, seuil 75 %)' || _traffic; _ping := case when _mention_warning then _mention end;
    when 'reminder' then
      _emoji := '🔴'; _color := '#dc2626'; _title := 'Toujours en Critical';
      _detail := E'*Performance*\n• CPU : 93,1 % (Critical, seuil 90 %)' || _traffic; _ping := _mention;
    when 'recovery' then
      _emoji := '✅'; _color := '#22c55e'; _title := 'Retour à la normale';
      _detail := 'Incident *Performance* clos. Durée : 23 min.';
    when 'offline' then
      _emoji := '🔴'; _color := '#dc2626'; _title := 'Critical';
      _detail := E'*Cloud hors ligne*\nAgents silencieux, les sondes répondent : le serveur web répond probablement.'; _ping := _mention;
    when 'agent' then
      _emoji := '🟠'; _color := '#f59e0b'; _title := 'Warning';
      _detail := '*Agent · Hébergement de démonstration* : l''agent n''envoie plus de données alors que le Cloud répond.'; _ping := case when _mention_warning then _mention end;
    else
      _emoji := '🔔'; _color := '#ffc629'; _title := 'Test de notification'; _ping := _mention;
      _detail := case when _mention is null then 'Si vous lisez ce message, les alertes YellowScope arriveront bien dans ce canal.'
                      else 'Si vous lisez ce message, les alertes YellowScope arriveront bien dans ce canal, avec la mention ' || _mention || '.' end;
  end case;

  _blocks := jsonb_build_array(
    jsonb_build_object('type', 'header', 'text', jsonb_build_object('type', 'plain_text',
      'text', _emoji || ' [TEST] ' || _title || case when _type = 'basic' then '' else ' · Cloud de démonstration' end, 'emoji', true)),
    jsonb_build_object('type', 'section', 'text', jsonb_build_object('type', 'mrkdwn', 'text', _detail)),
    jsonb_build_object('type', 'context', 'elements', jsonb_build_array(jsonb_build_object('type', 'mrkdwn',
      'text', case when _ping is null then 'Message de test, données fictives · YellowScope' else 'Message de test, données fictives · mention ' || _ping || ' · YellowScope' end)))
  );
  if _site is not null and _type <> 'basic' then
    _blocks := _blocks || jsonb_build_array(jsonb_build_object('type', 'actions', 'elements', jsonb_build_array(
      jsonb_build_object('type', 'button', 'text', jsonb_build_object('type', 'plain_text', 'text', 'Voir les incidents'), 'url', _site || '/incidents'))));
  end if;
  return jsonb_build_object(
    'text', coalesce(_ping || ' ', '') || _emoji || ' [TEST] ' || _title || case when _type = 'basic' then '' else ' · Cloud de démonstration' end,
    'attachments', jsonb_build_array(jsonb_build_object('color', _color, 'blocks', _blocks))
  );
end;
$$;
revoke all on function public.notify_sample_message(text, text, boolean, text) from public, anon, authenticated;

drop function public.send_test_notification();
create function public.send_test_notification(_type text default 'basic')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  _ws uuid;
  _id bigint;
  _s public.notification_settings;
  _msg jsonb;
begin
  select m.workspace_id into _ws from public.workspace_members m where m.user_id = auth.uid() and m.role = 'owner' limit 1;
  if _ws is null or not public.is_aal2() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if _type not in ('basic', 'critical', 'warning', 'reminder', 'recovery', 'offline', 'agent') then
    raise exception 'unknown test type' using errcode = '22023';
  end if;
  select * into _s from public.notification_settings where workspace_id = _ws and slack_webhook_url is not null;
  if not found then
    raise exception 'webhook not configured' using errcode = '22023';
  end if;
  _msg := public.notify_sample_message(_type, _s.mention, _s.mention_warning, _s.site_url);
  insert into public.notification_outbox (workspace_id, kind, summary, payload)
  values (_ws, 'test', public.notify_summary(_msg ->> 'text'), _msg) returning id into _id;
  perform public.dispatch_notifications();
  return _id;
end;
$$;
revoke all on function public.send_test_notification(text) from public, anon;
grant execute on function public.send_test_notification(text) to authenticated;
