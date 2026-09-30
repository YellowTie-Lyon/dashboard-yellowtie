-- Message de test « État réel actuel » : les VRAIS Server Clouds avec leurs VRAIES valeurs du moment (statut, CPU, RAM, disque, load)
-- et les domaines les plus sollicités des 15 dernières minutes. Les autres messages de test restent fictifs ([TEST], données inventées).
create function public.notify_live_message(_workspace_id uuid, _site text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _blocks jsonb := jsonb_build_array(
    jsonb_build_object('type', 'header', 'text', jsonb_build_object('type', 'plain_text', 'text', '📊 [TEST] État réel actuel', 'emoji', true)));
  c record;
  _p jsonb;
  _t jsonb;
  _traffic text;
  _line text;
  _status text;
begin
  for c in select cs.id, cs.name from public.cloud_servers cs where cs.workspace_id = _workspace_id order by cs.name loop
    select case s.status when 'normal' then '🟢 Normal' when 'warning' then '🟠 Warning' when 'critical' then '🔴 Critical'
                         when 'offline' then '🔴 Hors ligne' when 'maintenance' then '🔧 Maintenance' else '⚪ Aucune donnée' end
      into _status from public.cloud_status s where s.cloud_server_id = c.id;
    select st.last_point into _p from public.cloud_server_state st where st.cloud_server_id = c.id;
    _line := '*' || public.notify_esc(c.name) || '* · ' || coalesce(_status, '⚪ Aucune donnée');
    if _p is not null then
      _line := _line || E'\nCPU ' || coalesce(replace(trim_scale(round((_p ->> 'cpu_pct')::numeric, 1))::text, '.', ','), '—') || ' %'
        || ' · RAM ' || replace(trim_scale(round((_p ->> 'mem_used_pct')::numeric, 1))::text, '.', ',') || ' %'
        || ' · Disque ' || replace(trim_scale(round((_p ->> 'disk_used_pct')::numeric, 1))::text, '.', ',') || ' %'
        || ' · Load ' || replace(trim_scale(round((_p ->> 'load1')::numeric, 2))::text, '.', ',');
    end if;
    _t := public.compute_incident_traffic(c.id, now() - interval '15 minutes', now());
    if coalesce((_t ->> 'requests')::bigint, 0) > 0 then
      select string_agg(public.notify_esc(d ->> 'domain') || ' (' || replace(trim_scale((d ->> 'share')::numeric)::text, '.', ',') || ' %)', ', ' order by ord)
        into _traffic from jsonb_array_elements(_t -> 'domains') with ordinality x(d, ord) where ord <= 3;
      _line := _line || E'\n_Domaines les plus sollicités (15 min) :_ ' || coalesce(_traffic, '—');
    end if;
    _blocks := _blocks || jsonb_build_array(jsonb_build_object('type', 'section', 'text', jsonb_build_object('type', 'mrkdwn', 'text', left(_line, 2800))));
  end loop;
  _blocks := _blocks || jsonb_build_array(jsonb_build_object('type', 'context', 'elements', jsonb_build_array(jsonb_build_object('type', 'mrkdwn',
    'text', 'Message de test avec les données réelles du moment · YellowScope'))));
  if _site is not null then
    _blocks := _blocks || jsonb_build_array(jsonb_build_object('type', 'actions', 'elements', jsonb_build_array(
      jsonb_build_object('type', 'button', 'text', jsonb_build_object('type', 'plain_text', 'text', 'Ouvrir YellowScope'), 'url', _site))));
  end if;
  return jsonb_build_object('text', '📊 [TEST] État réel actuel',
                            'attachments', jsonb_build_array(jsonb_build_object('color', '#ffc629', 'blocks', _blocks)));
end;
$$;
revoke all on function public.notify_live_message(uuid, text) from public, anon, authenticated;

create or replace function public.send_test_notification(_type text default 'basic')
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
  if _type not in ('basic', 'critical', 'warning', 'reminder', 'recovery', 'offline', 'agent', 'live') then
    raise exception 'unknown test type' using errcode = '22023';
  end if;
  select * into _s from public.notification_settings where workspace_id = _ws and slack_webhook_url is not null;
  if not found then
    raise exception 'webhook not configured' using errcode = '22023';
  end if;
  _msg := case when _type = 'live' then public.notify_live_message(_ws, _s.site_url)
               else public.notify_sample_message(_type, _s.mention, _s.mention_warning, _s.site_url) end;
  insert into public.notification_outbox (workspace_id, kind, summary, payload)
  values (_ws, 'test', public.notify_summary(_msg ->> 'text'), _msg) returning id into _id;
  perform public.dispatch_notifications();
  return _id;
end;
$$;
