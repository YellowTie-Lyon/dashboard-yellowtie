-- Tests pgTAP : notifications Slack (règles d'envoi, secret du webhook, file d'attente, tentatives, rappels, droits).
begin;
select plan(66);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@example.test'),   -- propriétaire
  ('00000000-0000-0000-0000-00000000000b', 'lecteur@example.test'); -- lecteur
insert into public.workspace_members (workspace_id, user_id, role)
select id, '00000000-0000-0000-0000-00000000000b', 'viewer' from public.workspaces;
insert into public.cloud_servers (id, workspace_id, name, slug, cpu_cores)
select '00000000-0000-0000-0000-0000000000c1', id, 'Cloud 1', 'cloud-1', 12 from public.workspaces;
insert into public.web_hostings (id, cloud_server_id, name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'Hébergement 1');

-- pg_net remplacé par un enregistreur (aucun envoi réel).
create table public.tests_http (id bigint generated always as identity primary key, url text, body jsonb);
create table public.tests_mode (status integer not null);
insert into public.tests_mode values (200);
create or replace function public.notify_http_post(_url text, _body jsonb) returns bigint language plpgsql security definer set search_path = '' as $$
declare _id bigint;
begin insert into public.tests_http (url, body) values (_url, _body) returning id into _id; return _id; end $$;
create or replace function public.notify_http_result(_request_id bigint) returns table (status_code integer, timed_out boolean, error_msg text)
language plpgsql security definer set search_path = '' as $$
begin return query select (select m.status from public.tests_mode m), false, null::text from public.tests_http h where h.id = _request_id; end $$;

create function public.tests_as(_uid uuid, _aal text default 'aal2') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', _uid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', _uid, 'role', 'authenticated', 'aal', _aal)::text, true);
end $$;
create function public.tests_alerts() returns int language sql as $$ select count(*)::int from public.notification_outbox where kind = 'alert' $$;
create function public.tests_reason(_metric text, _level text, _value numeric) returns jsonb language sql as
$$ select jsonb_build_array(jsonb_build_object('metric', _metric, 'level', _level, 'value', _value, 'warn', 75, 'crit', 90, 'since', now())) $$;

-- ============================ Réglages et secret ================================================
set local role authenticated;
select public.tests_as('00000000-0000-0000-0000-00000000000a');
select lives_ok($$select public.save_notification_settings('https://hooks.slack.com/services/T000/B000/XXXXsecret', true, 'critical', true, 30, 'https://yellowscope.example')$$,
  'le propriétaire enregistre le webhook et les règles');
select is((select has_webhook from public.notification_settings), true, 'le client sait qu''un webhook est configuré');
select is((select webhook_hint from public.notification_settings), 'cret', 'seuls les 4 derniers caractères sont exposés');
select throws_ok($$select slack_webhook_url from public.notification_settings$$, '42501', null, 'l''adresse du webhook n''est JAMAIS lisible par le client');
select throws_ok($$select * from public.notification_settings$$, '42501', null, 'select * refusé (colonne secrète)');
select throws_ok($$select public.save_notification_settings('https://evil.example/x', true, 'critical', true, 30, null)$$, '23514', null,
  'une adresse qui n''est pas un webhook Slack est refusée (pas d''appel vers un hôte arbitraire)');
select throws_ok($$select public.save_notification_settings('http://hooks.slack.com/services/T000/B000/XXXXsecret', true, 'critical', true, 30, null)$$, '23514', null, 'HTTPS obligatoire');
select throws_ok($$select public.save_notification_settings(null, true, 'critical', true, 45, null)$$, '23514', null, 'délai de rappel limité aux valeurs prévues');
select lives_ok($$select public.save_notification_settings(null, true, 'critical', true, 30, null)$$, 'null conserve l''adresse actuelle');
select is((select has_webhook from public.notification_settings), true, 'adresse conservée');
select public.tests_as('00000000-0000-0000-0000-00000000000a', 'aal1');
select throws_ok($$select public.save_notification_settings(null, true, 'critical', true, 30, null)$$, '42501', 'forbidden', 'aal1 : refusé');
select public.tests_as('00000000-0000-0000-0000-00000000000b');
select throws_ok($$select public.save_notification_settings(null, false, 'critical', true, 30, null)$$, '42501', 'forbidden', 'un lecteur ne modifie pas les réglages');
select throws_ok($$select public.send_test_notification()$$, '42501', 'forbidden', 'un lecteur n''envoie pas de test');
select is((select count(*)::int from public.notification_settings), 1, 'un lecteur voit l''état (sans secret)');
reset role;

-- ============================ Règles d'envoi ====================================================
-- Warning avec seuil Critical : pas d'alerte ; escalade en Critical : alerte.
select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'performance', 'warning', public.tests_reason('cpu_pct', 'warning', 80), null);
select is(public.tests_alerts(), 0, 'Warning avec seuil Critical : aucune alerte');
select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'performance', 'critical', public.tests_reason('cpu_pct', 'critical', 92.4), null);
select is(public.tests_alerts(), 1, 'passage en Critical : une alerte');
select is((select kind from public.notification_outbox order by id desc limit 1), 'alert', 'type alert');
select is((select payload -> 'attachments' -> 0 ->> 'color' from public.notification_outbox order by id desc limit 1), '#dc2626', 'couleur rouge pour Critical');
select alike((select payload ->> 'text' from public.notification_outbox order by id desc limit 1), '%Critical · Cloud 1%', 'titre avec niveau et Cloud');
select alike((select payload::text from public.notification_outbox order by id desc limit 1), '%CPU : 92,4 %%seuil 90 %%', 'raison lisible : valeur et seuil');
select alike((select payload::text from public.notification_outbox order by id desc limit 1), '%https://yellowscope.example/incidents/%', 'lien vers la page de l''incident');
select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'performance', 'critical', public.tests_reason('cpu_pct', 'critical', 95), null);
select is(public.tests_alerts(), 1, 'aucun doublon tant que l''état ne change pas');

-- Domaines les plus sollicités joints au message (potentiellement impliqués).
insert into public.traffic_5m (web_hosting_id, workspace_id, ts, domain, requests, bytes)
select '00000000-0000-0000-0000-0000000000a1', id, now() - interval '3 minutes', 'gros.example.fr', 900, 10 from public.workspaces;
insert into public.traffic_5m (web_hosting_id, workspace_id, ts, domain, requests, bytes)
select '00000000-0000-0000-0000-0000000000a1', id, now() - interval '3 minutes', 'petit.example.fr', 100, 10 from public.workspaces;
update public.incidents set status = 'closed', ended_at = now();
select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'performance', 'critical', public.tests_reason('cpu_pct', 'critical', 91), null);
select alike((select payload::text from public.notification_outbox where kind = 'alert' order by id desc limit 1), '%gros.example.fr (90 %)%', 'domaines les plus sollicités dans le message');
select alike((select payload::text from public.notification_outbox where kind = 'alert' order by id desc limit 1), '%potentiellement impliqués%', 'formulation prudente');

-- Retour à la normale : seulement après une alerte, à la clôture.
select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'performance', 'ok', '[]'::jsonb, null);
select is((select count(*)::int from public.notification_outbox where kind = 'recovery'), 0, 'pas de message de retour avant la clôture');
update public.incidents set recovery_since = now() - interval '10 minutes' where status = 'recovery';
select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'performance', 'ok', '[]'::jsonb, null);
select is((select count(*)::int from public.notification_outbox where kind = 'recovery'), 1, 'message « retour à la normale » à la clôture');
select alike((select payload ->> 'text' from public.notification_outbox where kind = 'recovery'), '✅ Retour à la normale%', 'titre de retour');

-- Un incident jamais notifié ne produit pas de « retour à la normale ».
select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'disk', 'warning', public.tests_reason('disk_used_pct', 'warning', 82), null);
update public.incidents set recovery_since = now() - interval '10 minutes', status = 'recovery' where kind = 'disk';
select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'disk', 'ok', '[]'::jsonb, null);
select is((select count(*)::int from public.notification_outbox where kind = 'recovery'), 1, 'incident jamais notifié : pas de message de retour');

-- Seuil Warning : les Warning notifient aussi (couleur orange).
update public.notification_settings set min_level = 'warning';
select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'offline', 'warning', '[]'::jsonb, 'agents_silent');
select is((select payload -> 'attachments' -> 0 ->> 'color' from public.notification_outbox where kind = 'alert' order by id desc limit 1), '#f59e0b', 'Warning en orange');
select alike((select payload::text from public.notification_outbox where kind = 'alert' order by id desc limit 1), '%sondes répondent%', 'diagnostic d''un silence, formulé prudemment');

-- Désactivé : rien n'est mis en file.
update public.notification_settings set enabled = false;
select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'agent', 'critical', '[{"kind":"silent"}]'::jsonb, null);
select is((select count(*)::int from public.notification_outbox where kind = 'alert'), 3, 'notifications désactivées : aucune nouvelle alerte');
update public.notification_settings set enabled = true;

-- ============================ Envoi, tentatives ================================================
select is((select public.dispatch_notifications()), 4, 'l''envoi prend toutes les notifications dues (3 alertes + 1 retour)');
select is((select count(*)::int from public.tests_http where url = 'https://hooks.slack.com/services/T000/B000/XXXXsecret'), 4, 'chaque message part vers le webhook configuré');
select is((select count(*)::int from public.notification_outbox where status = 'sending'), 4, 'en attente de la réponse de Slack');
select public.dispatch_notifications();
select is((select count(*)::int from public.notification_outbox where status = 'sent'), 4, 'réponse 200 : marqué envoyé');
select is((select count(*)::int from public.notification_outbox where status = 'pending' or status = 'sending'), 0, 'file vide');

-- Échec (HTTP 500) : nouvelle tentative, puis échec définitif après 3 essais.
update public.tests_mode set status = 500;
insert into public.notification_outbox (workspace_id, kind, summary, payload) select id, 'test', 'essai', '{"text":"x"}'::jsonb from public.workspaces;
select public.dispatch_notifications();
select public.dispatch_notifications();
select is((select status || attempts from public.notification_outbox order by id desc limit 1), 'pending1', 'HTTP 500 : nouvelle tentative programmée');
select is((select last_error from public.notification_outbox order by id desc limit 1), 'HTTP 500', 'cause enregistrée');
update public.notification_outbox set next_try_at = now() - interval '1 minute' where status = 'pending';
select public.dispatch_notifications(); select public.dispatch_notifications();
update public.notification_outbox set next_try_at = now() - interval '1 minute' where status = 'pending';
select public.dispatch_notifications(); select public.dispatch_notifications();
select is((select status || attempts from public.notification_outbox order by id desc limit 1), 'failed3', 'échec définitif après 3 tentatives');

-- ============================ Rappels ==========================================================
update public.tests_mode set status = 200;
delete from public.notification_outbox;
update public.incidents set status = 'closed', ended_at = now();
select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'performance', 'critical', public.tests_reason('cpu_pct', 'critical', 93), null);
update public.notification_outbox set created_at = now() - interval '10 minutes';
select public.dispatch_notifications();
select is((select count(*)::int from public.notification_outbox where kind = 'reminder'), 0, 'pas de rappel avant le délai (30 min)');
update public.notification_outbox set created_at = now() - interval '40 minutes';
select public.dispatch_notifications();
select is((select count(*)::int from public.notification_outbox where kind = 'reminder'), 1, 'rappel après 30 minutes en Critical');
select public.dispatch_notifications();
select is((select count(*)::int from public.notification_outbox where kind = 'reminder'), 1, 'un seul rappel par période');

-- ============================ Test manuel ======================================================
delete from public.notification_outbox;
set local role authenticated;
select public.tests_as('00000000-0000-0000-0000-00000000000a');
select isnt(public.send_test_notification(), null, 'le propriétaire envoie un message de test');
reset role;
select is((select count(*)::int from public.notification_outbox where kind = 'test' and status = 'sending'), 1, 'le test part immédiatement');

-- ============================ Mentions ==========================================================
delete from public.notification_outbox;
update public.incidents set status = 'closed', ended_at = now();
set local role authenticated;
select public.tests_as('00000000-0000-0000-0000-00000000000a');
select throws_ok($$select public.save_notification_settings(null, true, 'warning', true, 30, null, '@everyone', false)$$, '23514', null, 'une mention libre est refusée (formats Slack uniquement)');
select throws_ok($$select public.save_notification_settings(null, true, 'warning', true, 30, null, '<!here> <!channel> <!here> <!channel>', false)$$, '23514', null, 'au plus 3 mentions');
select lives_ok($$select public.save_notification_settings(null, true, 'warning', true, 30, null, '<!here> <@U012ABCDEF>', false)$$, 'mentions valides : @here et une personne');
select is((select mention from public.notification_settings), '<!here> <@U012ABCDEF>', 'mention enregistrée');
reset role;
select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'performance', 'critical', public.tests_reason('cpu_pct', 'critical', 92), null);
select alike((select payload ->> 'text' from public.notification_outbox where kind = 'alert' order by id desc limit 1), '<!here> <@U012ABCDEF> 🔴 Critical%', 'l''alerte Critical commence par la mention (elle déclenche le ping)');
select unalike((select summary from public.notification_outbox where kind = 'alert' order by id desc limit 1), '<%', 'l''historique n''affiche pas la mention');
select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'disk', 'warning', public.tests_reason('disk_used_pct', 'warning', 82), null);
select unalike((select payload ->> 'text' from public.notification_outbox where kind = 'alert' and payload ->> 'text' like '%Warning%' order by id desc limit 1), '<!here>%', 'un Warning ne mentionne pas par défaut');
update public.notification_settings set mention_warning = true;
update public.incidents set status = 'closed', ended_at = now() where kind = 'disk';
select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'disk', 'warning', public.tests_reason('disk_used_pct', 'warning', 83), null);
select alike((select payload ->> 'text' from public.notification_outbox where kind = 'alert' and payload ->> 'text' like '%Warning%' order by id desc limit 1), '<!here>%', 'option cochée : le Warning mentionne aussi');
update public.incidents set recovery_since = now() - interval '10 minutes', status = 'recovery' where kind = 'performance' and status <> 'closed';
select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'performance', 'ok', '[]'::jsonb, null);
select unalike((select payload ->> 'text' from public.notification_outbox where kind = 'recovery' order by id desc limit 1), '<%', 'le retour à la normale ne mentionne personne');

-- ============================ Un message de test de chaque notification =========================
delete from public.notification_outbox;
update public.notification_settings set mention = '<!channel>', mention_warning = false;
set local role authenticated;
select public.tests_as('00000000-0000-0000-0000-00000000000a');
select lives_ok($$select public.send_test_notification('critical'), public.send_test_notification('warning'), public.send_test_notification('reminder'),
  public.send_test_notification('recovery'), public.send_test_notification('offline'), public.send_test_notification('agent'), public.send_test_notification('basic')$$,
  'les 7 messages de test sont acceptés');
select throws_ok($$select public.send_test_notification('inconnu')$$, '22023', 'unknown test type', 'type de test inconnu refusé');
reset role;
select is((select count(*)::int from public.notification_outbox where kind = 'test'), 7, 'sept tests en file');
select is((select count(*)::int from public.notification_outbox where kind = 'test' and payload::text like '%[TEST]%'), 7, 'tous marqués [TEST]');
select alike((select payload ->> 'text' from public.notification_outbox where summary like '%Critical · Cloud de démonstration' order by id limit 1), '<!channel> 🔴 [TEST] Critical%', 'test Critical avec mention');
select unalike((select payload ->> 'text' from public.notification_outbox where summary like '🟠 [TEST] Warning · Cloud de démonstration' limit 1), '<!channel>%', 'test Warning sans mention (option décochée)');
select unalike((select payload ->> 'text' from public.notification_outbox where summary like '✅%' limit 1), '<!channel>%', 'test « retour à la normale » sans mention');
select alike((select payload ->> 'text' from public.notification_outbox where summary like '%Toujours en Critical%' limit 1), '<!channel>%', 'test de rappel avec mention');
select is((select payload -> 'attachments' -> 0 ->> 'color' from public.notification_outbox where summary like '✅%' limit 1), '#22c55e', 'couleurs identiques aux vraies notifications');
select is((select count(*)::int from public.notification_outbox where kind = 'test' and payload::text like '%/incidents%'), 6, 'les tests d''incident portent le bouton vers les incidents');

-- État réel : les vrais Clouds et leurs vraies valeurs (pas de données inventées).
delete from public.notification_outbox;
insert into public.cloud_server_state (cloud_server_id, workspace_id, last_metrics_at, last_received_at, last_point)
select '00000000-0000-0000-0000-0000000000c1', id, now(), now(), '{"cpu_pct": 41.2, "load1": 3.5, "mem_used_pct": 55, "disk_used_pct": 44.5}'::jsonb from public.workspaces
on conflict (cloud_server_id) do update set last_point = excluded.last_point;
set local role authenticated;
select public.tests_as('00000000-0000-0000-0000-00000000000a');
select isnt(public.send_test_notification('live'), null, 'le message « état réel » est accepté');
reset role;
select alike((select payload::text from public.notification_outbox where kind = 'test' order by id desc limit 1), '%Cloud 1%CPU 41,2 %%Disque 44,5 %%', 'les vraies valeurs du Cloud apparaissent');
select alike((select payload::text from public.notification_outbox where kind = 'test' order by id desc limit 1), '%gros.example.fr%', 'et ses vrais domaines les plus sollicités');

select * from finish();
rollback;
