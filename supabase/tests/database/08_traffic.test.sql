-- Tests pgTAP : ingestion du trafic (agent 0.3.0), agrégats, lectures, trafic d'incident, entretien, droits.
begin;
select plan(52);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.test'),   -- propriétaire
  ('00000000-0000-0000-0000-00000000000b', 'b@example.test');   -- étranger
insert into public.cloud_servers (id, workspace_id, name, slug, cpu_cores)
select '00000000-0000-0000-0000-0000000000c1', id, 'Cloud 1', 'cloud-1', 12 from public.workspaces;
insert into public.web_hostings (id, cloud_server_id, name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'H1'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1', 'H2');
insert into public.web_hosting_credentials (web_hosting_id, token_hash)
select id, sha256(convert_to(repeat(substr('ab', n, 1), 64), 'UTF8'))
from (values ('00000000-0000-0000-0000-0000000000a1'::uuid, 1), ('00000000-0000-0000-0000-0000000000a2', 2)) v(id, n);
update public.web_hostings set token_public_id = repeat('a', 12), token_active = true where name = 'H1';
update public.web_hostings set token_public_id = repeat('b', 12), token_active = true where name = 'H2';

create function public.tests_token(_n int) returns text language sql as
$$ select 'ikh_' || repeat(substr('ab', _n, 1), 12) || '_' || repeat(substr('ab', _n, 1), 64) $$;
create function public.tests_bucket(_age_s int, _domains jsonb default null) returns jsonb language sql as $$
  select jsonb_build_object('ts', floor(extract(epoch from now()) / 300)::bigint * 300 - 150 + (60 - _age_s), 'win', 300, 'lines', 900, 'bad', 2, 'trunc', 0,
    'n', 900, 'b', 123456, 's', jsonb_build_array(800, 20, 60, 20), 'm', 40,
    'ua', jsonb_build_object('g', 100, 'b', 200, 'h', 590, 'e', 10),
    'd', coalesce(_domains, jsonb_build_array(
        jsonb_build_object('h', 'a.example.fr', 'n', 700, 'b', 100000, 's', jsonb_build_array(600, 20, 60, 20), 'm', 30, 'bt', 250),
        jsonb_build_object('h', 'b.example.fr', 'n', 200, 'b', 23456, 's', jsonb_build_array(200, 0, 0, 0), 'm', 10, 'bt', 50))),
    'u', jsonb_build_array(
        jsonb_build_object('h', 'a.example.fr', 'p', '/wp-login.php', 'n', 500, 'e', 60),
        jsonb_build_object('h', 'b.example.fr', 'p', '/', 'n', 100, 'e', 0)),
    'i', jsonb_build_array(jsonb_build_object('ip', '203.0.113.9', 'n', 400), jsonb_build_object('ip', '198.51.100.2', 'n', 50))) $$;
create function public.tests_hb(_token text, _traffic jsonb) returns jsonb language plpgsql as $$
begin
  perform set_config('request.headers', jsonb_build_object('x-agent-token', _token)::text, true);
  return public.agent_heartbeat(jsonb_build_object('v', 1, 'agent_version', '0.3.0', 'hostname', 'od-1',
    'agent', jsonb_build_object('backlog', 0), 'points', '[]'::jsonb, 'traffic', _traffic));
end $$;
create function public.tests_backdate() returns void language sql security definer as
$$ update public.web_hosting_state set last_seen_at = now() - interval '1 minute' $$;
create function public.tests_as(_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', _uid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
end $$;
create table public.tests_res (label text, r jsonb);
grant all on public.tests_res to anon, authenticated;

-- ============================ Contrat ===========================================================
select is((select proargnames from pg_proc where proname = 'agent_heartbeat' and pronamespace = 'public'::regnamespace), null,
  'agent_heartbeat garde son paramètre sans nom (exigence PostgREST)');
set local role anon;
select throws_ok($$select public.ingest_traffic('00000000-0000-0000-0000-0000000000a1', gen_random_uuid(), '[]'::jsonb)$$, '42501', null,
  'ingest_traffic n''est pas appelable par les clients');
select throws_ok($$select public.compute_incident_traffic('00000000-0000-0000-0000-0000000000c1', now(), now())$$, '42501', null,
  'compute_incident_traffic n''est pas appelable par les clients');
select throws_ok($$select public.traffic_maintenance()$$, '42501', null, 'traffic_maintenance fermée aux clients');
select throws_ok($$select public.purge_traffic()$$, '42501', null, 'purge_traffic fermée aux clients');

-- ============================ Ingestion =========================================================
insert into public.tests_res select 'hb1', public.tests_hb(public.tests_token(1), jsonb_build_array(public.tests_bucket(60)));
select is((select r ->> 'traffic_accepted' from public.tests_res where label = 'hb1'), '1', 'un seau valide est accepté');
select is((select r ->> 'ok' from public.tests_res where label = 'hb1'), 'true', 'la réponse habituelle du heartbeat est conservée');
reset role;
select is((select count(*)::int from public.traffic_5m), 2, 'une ligne par domaine');
select is((select requests from public.traffic_5m where domain = 'a.example.fr'), 700, 'requêtes du domaine');
select is((select r5xx from public.traffic_5m where domain = 'a.example.fr'), 20, 'erreurs 5xx du domaine');
select is((select bots from public.traffic_5m where domain = 'a.example.fr'), 250, 'requêtes de robots du domaine');
select is((select count(*)::int from public.traffic_detail), 1, 'un détail par fenêtre');
select is((select (totals ->> 'n')::int from public.traffic_detail), 900, 'total de la fenêtre');
select is((select jsonb_array_length(paths) from public.traffic_detail), 2, 'URL les plus fréquentes conservées');
select isnt((select traffic_last_ts from public.web_hosting_state where web_hosting_id = '00000000-0000-0000-0000-0000000000a1'), null,
  'la dernière fenêtre acceptée est mémorisée');

-- Renvoi du même seau (réponse perdue) : aucun doublon de comptage.
select public.tests_backdate();
set local role anon;
insert into public.tests_res select 'hb2', public.tests_hb(public.tests_token(1), jsonb_build_array(public.tests_bucket(60)));
select is((select r ->> 'traffic_accepted' from public.tests_res where label = 'hb2'), '0', 'un seau déjà reçu est ignoré');
reset role;
select is((select requests from public.traffic_5m where domain = 'a.example.fr'), 700, 'aucun double comptage après un renvoi');

-- Deux fenêtres dans le même seau de 5 minutes s'additionnent.
select public.tests_backdate();
set local role anon;
insert into public.tests_res select 'hb3', public.tests_hb(public.tests_token(1), jsonb_build_array(public.tests_bucket(50)));
reset role;
select is((select requests from public.traffic_5m where domain = 'a.example.fr' order by ts desc limit 1)::int, 1400,
  'deux fenêtres du même seau s''additionnent');

-- Validation : ts hors bornes, domaine invalide remplacé, nombres absurdes ignorés.
select public.tests_backdate();
set local role anon;
insert into public.tests_res select 'hb4', public.tests_hb(public.tests_token(1), jsonb_build_array(public.tests_bucket(90000)));
select is((select r ->> 'traffic_accepted' from public.tests_res where label = 'hb4'), '0', 'un horodatage vieux de plus de 24 h est refusé');
select public.tests_backdate();
insert into public.tests_res select 'hb5', public.tests_hb(public.tests_token(1), jsonb_build_array(
  public.tests_bucket(-5000), to_jsonb('texte'::text), jsonb_build_object('ts', 'x')));
select is((select r ->> 'traffic_accepted' from public.tests_res where label = 'hb5'), '0', 'seaux invalides (futur, type, ts) ignorés sans erreur');
select public.tests_backdate();
insert into public.tests_res select 'hb6', public.tests_hb(public.tests_token(2), jsonb_build_array(public.tests_bucket(30, jsonb_build_array(
  jsonb_build_object('h', 'EVIL"; drop table', 'n', 10, 'b', 100, 's', jsonb_build_array(10, 0, 0, 0), 'm', 0, 'bt', 0)))));
select is((select r ->> 'traffic_accepted' from public.tests_res where label = 'hb6'), '1', 'seau avec un domaine invalide accepté');
reset role;
select is((select count(*)::int from public.traffic_5m where domain = '(autre)'), 1, 'un domaine invalide est regroupé sous « (autre) »');
select public.tests_backdate();
set local role anon;
insert into public.tests_res select 'hb7', public.tests_hb(public.tests_token(2), jsonb_build_array(public.tests_bucket(20, jsonb_build_array(
  jsonb_build_object('h', 'x.example.fr', 'n', -5, 'b', 1)))));
select is((select r ->> 'traffic_accepted' from public.tests_res where label = 'hb7'), '1', 'ligne négative écartée, seau conservé');
reset role;
select is((select count(*)::int from public.traffic_5m where domain = 'x.example.fr'), 0, 'un nombre négatif n''est jamais enregistré');

-- Au plus 3 seaux par heartbeat ; l'authentification reste prioritaire.
select public.tests_backdate();
set local role anon;
insert into public.tests_res select 'hb8', public.tests_hb(public.tests_token(2), jsonb_build_array(
  public.tests_bucket(10), public.tests_bucket(11), public.tests_bucket(12), public.tests_bucket(13)));
select is((select r ->> 'traffic_accepted' from public.tests_res where label = 'hb8'), '0', 'plus de 3 seaux : tout est ignoré');
select public.tests_backdate();
select throws_ok($$select public.tests_hb('ikh_cccccccccccc_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', '[]'::jsonb)$$,
  'PT401', null, 'un token inconnu ne peut rien écrire');
select public.tests_backdate();
select throws_ok($$select public.agent_heartbeat(jsonb_build_object('v', 1, 'pad', repeat('x', 70000), 'traffic', '[]'::jsonb))$$,
  'PT400', null, 'corps supérieur à 64 Ko : refusé');

-- ============================ Lectures ===========================================================
reset role;
insert into public.traffic_5m (web_hosting_id, workspace_id, ts, domain, requests, bytes, r5xx)
select '00000000-0000-0000-0000-0000000000a2', id, date_trunc('hour', now()) - interval '2 hours', 'old.example.fr', 50, 10, 0
from public.workspaces;

set local role authenticated;
select public.tests_as('00000000-0000-0000-0000-00000000000a');
select is((select domain from public.get_top_domains('00000000-0000-0000-0000-0000000000c1', 60, 10) limit 1), 'a.example.fr',
  'le domaine le plus sollicité arrive en tête');
select is((select count(*)::int from public.get_top_domains('00000000-0000-0000-0000-0000000000c1', 60, 10)), 3,
  'top domaines : les 3 domaines de l''heure (les anciens sont exclus)');
select is((select hosting_name from public.get_top_domains('00000000-0000-0000-0000-0000000000c1', 60, 10) limit 1), 'H1',
  'chaque domaine est rattaché à son hébergement');
select is((select count(*)::int from public.get_top_domains('00000000-0000-0000-0000-0000000000c1', 60, 1)), 1, 'la limite est respectée');
select is((select count(*)::int from public.get_top_domains('00000000-0000-0000-0000-0000000000c1', 240, 10)), 4, 'la période est paramétrable');
select ok((select share from public.get_top_domains('00000000-0000-0000-0000-0000000000c1', 60, 10) limit 1) > 50,
  'la part du trafic est calculée');

select is((public.get_hosting_traffic('00000000-0000-0000-0000-0000000000a1', 60) #>> '{totals,requests}')::int, 1800,
  'totaux de l''hébergement');
select is((public.get_hosting_traffic('00000000-0000-0000-0000-0000000000a1', 60) #>> '{paths,0,path}'), '/wp-login.php',
  'URL la plus sollicitée');
select is((public.get_hosting_traffic('00000000-0000-0000-0000-0000000000a1', 60) #>> '{ips,0,ip}'), '203.0.113.9', 'IP la plus active');
select is((public.get_hosting_traffic('00000000-0000-0000-0000-0000000000a1', 60) #>> '{agents,googlebot}')::int, 200, 'types de visiteurs');
select ok(jsonb_array_length(public.get_hosting_traffic('00000000-0000-0000-0000-0000000000a1', 60) -> 'series') >= 1, 'courbe de requêtes');

-- ============================ Trafic d'un incident ==============================================
reset role;
insert into public.traffic_5m (web_hosting_id, workspace_id, ts, domain, requests, bytes, r5xx)
select '00000000-0000-0000-0000-0000000000a1', id, now() - interval '40 minutes', 'a.example.fr', 900, 10, 5 from public.workspaces;
insert into public.traffic_5m (web_hosting_id, workspace_id, ts, domain, requests, bytes)
select '00000000-0000-0000-0000-0000000000a2', id, now() - interval '40 minutes', 'b.example.fr', 100, 10 from public.workspaces;
insert into public.traffic_detail (web_hosting_id, workspace_id, ts, totals, paths)
select '00000000-0000-0000-0000-0000000000a1', id, now() - interval '40 minutes', '{"n":900}'::jsonb,
       '[{"h":"a.example.fr","p":"/wp-login.php","n":800,"e":5}]'::jsonb from public.workspaces;
insert into public.incidents (id, workspace_id, cloud_server_id, kind, status, severity_max, started_at, ended_at)
select '00000000-0000-0000-0000-0000000000f1', id, '00000000-0000-0000-0000-0000000000c1', 'performance', 'closed',
       'critical', now() - interval '60 minutes', now() - interval '30 minutes' from public.workspaces;
set local role authenticated;
select public.tests_as('00000000-0000-0000-0000-00000000000a');
select is((public.get_incident_traffic('00000000-0000-0000-0000-0000000000f1') #>> '{domains,0,domain}'), 'a.example.fr',
  'trafic d''un incident : domaine potentiellement impliqué en tête (calcul à la volée)');
select is((public.get_incident_traffic('00000000-0000-0000-0000-0000000000f1') #>> '{hostings,0,name}'), 'H1', 'hébergement en tête');
select is((public.get_incident_traffic('00000000-0000-0000-0000-0000000000f1') #>> '{paths,0,path}'), '/wp-login.php', 'URL la plus sollicitée pendant l''incident');
reset role;
select is((public.traffic_maintenance() ->> 'snapshots')::int, 1, 'l''entretien fige le trafic de l''incident clos');
select isnt((select traffic_snapshot from public.incidents where id = '00000000-0000-0000-0000-0000000000f1'), null, 'instantané enregistré');
delete from public.traffic_5m;
set local role authenticated;
select public.tests_as('00000000-0000-0000-0000-00000000000a');
select is((public.get_incident_traffic('00000000-0000-0000-0000-0000000000f1') #>> '{domains,0,domain}'), 'a.example.fr',
  'l''instantané survit à la purge du détail');

-- ============================ Isolation ==========================================================
select public.tests_as('00000000-0000-0000-0000-00000000000b');
select is((select count(*)::int from public.traffic_detail), 0, 'un étranger ne voit aucun détail de trafic');
select is(public.get_hosting_traffic('00000000-0000-0000-0000-0000000000a1', 60), null, 'un étranger n''obtient rien pour un hébergement');
select is(public.get_incident_traffic('00000000-0000-0000-0000-0000000000f1'), null, 'ni pour un incident');
select throws_ok($$insert into public.traffic_5m (web_hosting_id, workspace_id, ts, domain, requests, bytes)
  select '00000000-0000-0000-0000-0000000000a1', id, now(), 'z.fr', 1, 1 from public.workspaces$$, '42501', null,
  'aucune écriture depuis le client');

-- ============================ Entretien =========================================================
reset role;
insert into public.traffic_5m (web_hosting_id, workspace_id, ts, domain, requests, bytes)
select '00000000-0000-0000-0000-0000000000a1', id, date_trunc('hour', now()) - interval '1 hour' + interval '5 minutes', 'h.example.fr', 10, 1
from public.workspaces;
insert into public.traffic_5m (web_hosting_id, workspace_id, ts, domain, requests, bytes)
select '00000000-0000-0000-0000-0000000000a1', id, date_trunc('hour', now()) - interval '1 hour' + interval '10 minutes', 'h.example.fr', 5, 1
from public.workspaces;
select public.traffic_maintenance();
select is((select requests from public.traffic_1h where domain = 'h.example.fr'), 15, 'agrégat horaire par domaine');
select public.traffic_maintenance();
select is((select requests from public.traffic_1h where domain = 'h.example.fr'), 15, 'l''agrégat est idempotent');
insert into public.traffic_5m (web_hosting_id, workspace_id, ts, domain, requests, bytes)
select '00000000-0000-0000-0000-0000000000a1', id, now() - interval '4 days', 'vieux.fr', 1, 1 from public.workspaces;
select public.purge_traffic();
select is((select count(*)::int from public.traffic_5m where domain = 'vieux.fr'), 0, 'la purge supprime le détail de plus de 3 jours');
select throws_ok($$select public.purge_traffic(1, 30)$$, '22023', null, 'garde-fou : pas de purge sous 2 jours');

select * from finish();
rollback;
