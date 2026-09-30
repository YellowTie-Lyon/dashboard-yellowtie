-- Tests pgTAP : seuils, statuts, hystérésis, silences, sondes, droits.
-- NB : now() est constant dans une transaction ; une fenêtre de N minutes couvre donc N+1 relevés (i = 0..N).
begin;
select plan(87);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.test'),   -- propriétaire (1er utilisateur)
  ('00000000-0000-0000-0000-00000000000b', 'b@example.test'),   -- étranger
  ('00000000-0000-0000-0000-00000000000c', 'c@example.test');   -- lecteur
insert into public.workspace_members (workspace_id, user_id, role)
select id, '00000000-0000-0000-0000-00000000000c', 'viewer' from public.workspaces;
insert into public.workspaces (id, name) values ('00000000-0000-0000-0000-0000000000f2', 'Autre');
insert into public.cloud_servers (id, workspace_id, name, slug, cpu_cores)
values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f2', 'Cloud autre', 'autre', 4);

insert into public.cloud_servers (id, workspace_id, name, slug, cpu_cores)
select '00000000-0000-0000-0000-0000000000c1', id, 'Cloud 1', 'cloud-1', 12 from public.workspaces where name <> 'Autre';
insert into public.web_hostings (id, cloud_server_id, name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'H1'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1', 'H2');

-- Aides ---------------------------------------------------------------------------------------------------------
create function public.tests_seed(_load_pc float, _cpu float, _mem float, _disk float, _minutes int default 10)
returns void language sql as $$
  delete from public.metrics where cloud_server_id = '00000000-0000-0000-0000-0000000000c1';
  insert into public.metrics (cloud_server_id, ts, cpu_cores, load1, load5, load15, load1_per_core, load5_per_core, cpu_pct,
    mem_total_mb, mem_used_mb, mem_avail_mb, mem_used_pct, swap_total_mb, swap_used_mb, swap_used_pct,
    disk_total_mb, disk_used_mb, disk_avail_mb, disk_used_pct, uptime_s)
  select '00000000-0000-0000-0000-0000000000c1', now() - make_interval(mins => i), 12, _load_pc * 12, _load_pc * 12, _load_pc * 12,
         _load_pc, _load_pc, _cpu, 1000, 400, 600, _mem, 100, 10, 10, 1000, 500, 500, _disk, 1000
  from generate_series(0, _minutes) i;
$$;
create function public.tests_fresh() returns void language sql as $$
  insert into public.cloud_server_state (cloud_server_id, workspace_id, last_metrics_at, last_received_at, last_point)
  select id, workspace_id, now(), now(), '{}'::jsonb from public.cloud_servers where id = '00000000-0000-0000-0000-0000000000c1'
  on conflict (cloud_server_id) do update set last_received_at = now(), last_metrics_at = now();
  insert into public.web_hosting_state (web_hosting_id, workspace_id, last_seen_at)
  select id, workspace_id, now() from public.web_hostings where cloud_server_id = '00000000-0000-0000-0000-0000000000c1'
  on conflict (web_hosting_id) do update set last_seen_at = now();
$$;
create function public.tests_eval() returns text language plpgsql as $$
begin
  perform public.evaluate_cloud('00000000-0000-0000-0000-0000000000c1');
  return (select status from public.cloud_status where cloud_server_id = '00000000-0000-0000-0000-0000000000c1');
end $$;
create function public.tests_detail(_key text) returns text language sql as
$$ select detail ->> _key from public.cloud_status where cloud_server_id = '00000000-0000-0000-0000-0000000000c1' $$;
create function public.tests_level(_metric text) returns text language sql as
$$ select level from public.alert_state where cloud_server_id = '00000000-0000-0000-0000-0000000000c1' and metric = _metric $$;

-- ============================ Valeurs par défaut ==========================================================
select is((select count(*)::int from public.alert_rules where cloud_server_id is null and workspace_id =
            (select id from public.workspaces where name <> 'Autre')), 8, 'huit règles par défaut sont semées pour le workspace');
select is((select count(*)::int from public.alert_rules where cloud_server_id is null and enabled and workspace_id =
            (select id from public.workspaces where name <> 'Autre')), 4, 'quatre règles actives au départ (load/cœur, CPU, RAM, disque)');
select is((select count(*)::int from public.alert_rules where workspace_id = '00000000-0000-0000-0000-0000000000f2'), 8,
          'tout nouveau workspace reçoit lui aussi ses règles par défaut');
select is((select warn_threshold || '/' || crit_threshold from public.alert_rules
            where metric = 'mem_used_pct' and cloud_server_id is null and workspace_id = (select id from public.workspaces where name <> 'Autre')),
          '85/95', 'RAM : 85 % / 95 %');
select is((select warn_threshold || '/' || crit_threshold from public.alert_rules
            where metric = 'disk_used_pct' and cloud_server_id is null and workspace_id = (select id from public.workspaces where name <> 'Autre')),
          '80/90', 'disque : 80 % / 90 %');

-- ============================ Statuts et seuils ===========================================================
select public.tests_fresh();
select public.tests_seed(0.2, 10, 30, 40);
select is(public.tests_eval(), 'normal', 'valeurs basses : Normal');
select is((select jsonb_array_length(detail -> 'reasons') from public.cloud_status), 0, 'aucune raison quand tout va bien');
select is(public.tests_detail('connectivity'), 'ok', 'connectivité ok');

select public.tests_seed(0.7, 10, 30, 40);
select is(public.tests_eval(), 'warning', 'load par cœur 0,7 > 0,6 pendant la fenêtre : Warning');
select is((select detail -> 'reasons' -> 0 ->> 'metric' from public.cloud_status), 'load1_per_core', 'la raison désigne la métrique');
select is((select (detail -> 'reasons' -> 0 ->> 'value')::float from public.cloud_status), 0.7::float, 'la raison porte la dernière valeur');

update public.cloud_status set status_since = now() - interval '1 hour';
select is(public.tests_eval(), 'warning', 're-évaluation sans changement : toujours Warning');
select ok((select status_since < now() - interval '30 minutes' from public.cloud_status), 'le début du statut est conservé tant qu''il ne change pas');

select public.tests_seed(1.2, 10, 30, 40);
select is(public.tests_eval(), 'critical', 'load par cœur 1,2 > 1,0 : Critical');
select ok((select status_since > now() - interval '1 minute' from public.cloud_status), 'le début du statut est renouvelé au changement');

-- Hystérésis : Critical -> (0,95 : entre seuil et seuil - marge) reste Critical -> 0,75 Warning -> 0,55 reste Warning -> 0,4 Normal
select public.tests_seed(0.95, 10, 30, 40);
select is(public.tests_eval(), 'critical', 'hystérésis : à 0,95 (au-dessus de 1,0 - 0,1) le Critical est maintenu');
select public.tests_seed(0.75, 10, 30, 40);
select is(public.tests_eval(), 'warning', 'retour stable sous 0,9 : Critical -> Warning');
select public.tests_seed(0.55, 10, 30, 40);
select is(public.tests_eval(), 'warning', 'hystérésis : à 0,55 (au-dessus de 0,6 - 0,1) le Warning est maintenu');
select public.tests_seed(0.4, 10, 30, 40);
select is(public.tests_eval(), 'normal', 'retour stable sous 0,5 : Warning -> Normal');
select is(public.tests_level('load1_per_core'), 'ok', 'niveau de la règle revenu à ok');

-- Ratio de dépassement : 3 relevés sur 6 au-dessus du seuil = 0,5 < 0,8 : pas de Warning
delete from public.alert_state;
select public.tests_seed(0.3, 10, 30, 40);
update public.metrics set load1_per_core = 0.7 where ts > now() - interval '3 minutes';
select is(public.tests_eval(), 'normal', 'moins de 80 % de relevés au-dessus du seuil : pas d''alerte');
update public.metrics set load1_per_core = 0.7 where ts > now() - interval '5 minutes';
select is(public.tests_eval(), 'warning', '5 relevés sur 6 (83 %) au-dessus du seuil : Warning');

-- Pas assez de relevés : on ne change rien (ni alerte inventée, ni retour à la normale déclaré)
update public.alert_state set level = 'critical' where metric = 'load1_per_core';
select public.tests_seed(0.2, 10, 30, 40, 0);
select is(public.tests_eval(), 'critical', 'un seul relevé dans la fenêtre : le niveau précédent est conservé');

-- Autres métriques
delete from public.alert_state;
select public.tests_seed(0.2, 95, 30, 40);
select is(public.tests_eval(), 'critical', 'CPU 95 % > 90 % : Critical');
select public.tests_seed(0.2, 10, 96, 40);
select is(public.tests_eval(), 'critical', 'RAM 96 % > 95 % : Critical');
select public.tests_seed(0.2, 10, 30, 85);
select is(public.tests_eval(), 'warning', 'disque 85 % > 80 % : Warning');
select is(public.tests_level('cpu_pct'), 'ok', 'les autres règles restent à ok');
select public.tests_seed(0.2, 10, 96, 91);
select is(public.tests_eval(), 'critical', 'plusieurs métriques en alerte : le pire niveau l''emporte');
select is((select jsonb_array_length(detail -> 'reasons') from public.cloud_status), 2, 'toutes les raisons sont listées');

-- Surcharges par Cloud
delete from public.alert_state;
insert into public.alert_rules (workspace_id, cloud_server_id, metric, warn_threshold, crit_threshold, window_minutes,
                                min_breach_ratio, recover_margin, recover_minutes, enabled)
select workspace_id, id, 'load1_per_core', 2, 3, 5, 0.8, 0.1, 5, true from public.cloud_servers where id = '00000000-0000-0000-0000-0000000000c1';
select public.tests_seed(1.2, 10, 30, 40);
select is(public.tests_eval(), 'normal', 'la surcharge du Cloud (warn 2,0) remplace la valeur par défaut (0,6)');
update public.alert_rules set enabled = false where cloud_server_id = '00000000-0000-0000-0000-0000000000c1';
select public.tests_seed(5, 10, 30, 40);
select is(public.tests_eval(), 'normal', 'une surcharge désactivée neutralise la règle pour ce Cloud');
select is(public.tests_level('load1_per_core'), null, 'aucun niveau résiduel pour une règle désactivée');
delete from public.alert_rules where cloud_server_id = '00000000-0000-0000-0000-0000000000c1';
select is(public.tests_eval(), 'critical', 'surcharge supprimée : retour aux valeurs par défaut');

-- ============================ Silences et connectivité ====================================================
select public.tests_seed(0.2, 10, 30, 40);
update public.web_hostings set probe_url = 'https://exemple.fr/ik-probe.txt' where name = 'H1';
update public.web_hosting_state set last_seen_at = now() - interval '10 minutes';
update public.cloud_server_state set last_received_at = now() - interval '10 minutes';
select is(public.tests_eval(), 'offline', 'aucun agent depuis 10 min (seuil 240 s) : Offline');
select is(public.tests_detail('offline_diagnosis'), 'unknown_cause', 'sonde sans résultat : cause indéterminée');
insert into public.probe_results (web_hosting_id, ts, ok, http_status) values ('00000000-0000-0000-0000-0000000000a1', now() - interval '1 minute', true, 200);
select public.tests_eval();
select is(public.tests_detail('offline_diagnosis'), 'agents_silent', 'agents muets mais site qui répond : problème probable agent / cron');
delete from public.probe_results;
insert into public.probe_results (web_hosting_id, ts, ok, http_status, error) values
  ('00000000-0000-0000-0000-0000000000a1', now() - interval '1 minute', false, null, 'timeout'),
  ('00000000-0000-0000-0000-0000000000a1', now() - interval '2 minutes', false, 503, null);
select public.tests_eval();
select is(public.tests_detail('offline_diagnosis'), 'unreachable_probable', 'agents muets et deux sondes en échec : potentiellement inaccessible');
delete from public.probe_results;
insert into public.probe_results (web_hosting_id, ts, ok, http_status) values ('00000000-0000-0000-0000-0000000000a1', now() - interval '1 minute', false, 500);
select public.tests_eval();
select is(public.tests_detail('offline_diagnosis'), 'unknown_cause', 'un seul échec de sonde ne suffit pas à conclure');

select public.tests_fresh();
update public.cloud_server_state set last_received_at = now() - interval '10 minutes';
select is(public.tests_eval(), 'unknown', 'agents vivants mais collecteur muet : valeurs système obsolètes');
select is(public.tests_detail('connectivity'), 'metrics_stale', 'la raison est « collecteur silencieux »');

select public.tests_fresh();
update public.web_hosting_state set last_seen_at = now() - interval '120 seconds';
update public.cloud_server_state set last_received_at = now() - interval '120 seconds';
select is(public.tests_eval(), 'normal', 'retard de 2 minutes (sous le seuil) : statut inchangé');
select is(public.tests_detail('connectivity'), 'delayed', 'mais signalé comme « en retard »');

delete from public.web_hosting_state;
delete from public.cloud_server_state;
select is(public.tests_eval(), 'unknown', 'aucun agent jamais vu : Aucune donnée');
select is(public.tests_detail('connectivity'), 'never', 'connectivité : jamais');

select public.tests_fresh();
update public.cloud_servers set maintenance = true where id = '00000000-0000-0000-0000-0000000000c1';
select is(public.tests_eval(), 'maintenance', 'mode maintenance');
update public.cloud_servers set maintenance = false where id = '00000000-0000-0000-0000-0000000000c1';
update public.web_hostings set is_active = false where name = 'H1';
update public.web_hosting_state set last_seen_at = now() - interval '10 minutes' where web_hosting_id = '00000000-0000-0000-0000-0000000000a2';
select is(public.tests_eval(), 'offline', 'les agents d''hébergements désactivés ne comptent pas comme vivants');
update public.web_hostings set is_active = true where name = 'H1';

select public.tests_fresh();
select is(public.evaluate_all(), 2, 'evaluate_all traite tous les Clouds');
select is((select detail ->> 'errors' from public.job_state where name = 'evaluate'), '0', 'l''exécution est enregistrée sans erreur');

-- ============================ Aide au calibrage ===========================================================
select public.tests_seed(0.5, 20, 30, 40, 9);
select is((select n from public.get_metric_percentiles('00000000-0000-0000-0000-0000000000c1', 7) where metric = 'load1_per_core'), 10,
          'percentiles : nombre de relevés');
select is((select p50 from public.get_metric_percentiles('00000000-0000-0000-0000-0000000000c1', 7) where metric = 'load1_per_core'),
          0.5::float, 'percentiles : médiane');
select is((select count(*)::int from public.get_metric_percentiles('00000000-0000-0000-0000-0000000000c1', 7)), 8, 'percentiles : les huit métriques');

-- ============================ Sondes (pg_net simulé) ======================================================
create table public.tests_calls (id bigint generated always as identity, url text);
create table public.tests_http (id bigint, status int, timed_out boolean, err text);
create or replace function public.probe_http_get(_url text) returns bigint language plpgsql as $$
declare i bigint; begin insert into public.tests_calls (url) values (_url) returning id into i; return i; end $$;
create or replace function public.probe_http_result(_request_id bigint) returns table (status_code integer, timed_out boolean, error_msg text)
language sql as $$ select h.status, h.timed_out, h.err from public.tests_http h where h.id = _request_id $$;

delete from public.probe_results;
select public.tests_fresh();
select is(public.run_probes(), 1, 'une sonde envoyée pour l''hébergement configuré');
select is((select url from public.tests_calls), 'https://exemple.fr/ik-probe.txt', 'la sonde vise l''URL configurée');
select is(public.run_probes(), 0, 'agent à jour : pas de nouvelle sonde avant 5 minutes');
insert into public.tests_http values ((select max(id) from public.tests_calls), 200, false, null);
select public.run_probes();
select is((select ok from public.probe_results order by id desc limit 1), true, 'réponse 200 : sonde OK');
select is((select count(*)::int from public.probe_requests), 0, 'la requête résolue est retirée');
select ok((select latency_ms >= 0 from public.probe_results order by id desc limit 1), 'latence enregistrée');

-- 404 = la couche web répond : OK ; 503 = échec ; délai dépassé = échec
delete from public.probe_results;
update public.web_hostings set probe_url = 'https://exemple.fr/introuvable' where name = 'H1';
select public.tests_fresh();
select public.run_probes();
insert into public.tests_http values ((select max(id) from public.tests_calls), 404, false, null);
select public.run_probes();
select is((select ok from public.probe_results order by id desc limit 1), true, 'réponse 404 : la couche web répond, sonde OK');

delete from public.probe_results;
select public.run_probes();
insert into public.tests_http values ((select max(id) from public.tests_calls), 503, false, null);
select public.run_probes();
select is((select ok from public.probe_results order by id desc limit 1), false, 'réponse 503 : sonde en échec');

delete from public.probe_results;
select public.run_probes();
insert into public.tests_http values ((select max(id) from public.tests_calls), null, true, 'Timeout of 5000 ms reached');
select public.run_probes();
select is((select ok from public.probe_results order by id desc limit 1), false, 'délai dépassé : sonde en échec');

-- Sans réponse au bout de 30 s : échec « pas de réponse »
delete from public.probe_results;
delete from public.probe_requests;
insert into public.probe_requests (request_id, web_hosting_id, sent_at) values (999, '00000000-0000-0000-0000-0000000000a1', now() - interval '1 minute');
select public.collect_probe_results();
select is((select error from public.probe_results order by id desc limit 1), 'pas de réponse', 'requête sans réponse : échec après 30 s');

-- Cadence : chaque minute quand l'agent est en retard
delete from public.probe_results; delete from public.tests_calls;
insert into public.probe_results (web_hosting_id, ts, ok) values ('00000000-0000-0000-0000-0000000000a1', now() - interval '2 minutes', true);
select public.tests_fresh();
select is(public.run_probes(), 0, 'agent à jour, dernière sonde il y a 2 min : pas de sonde');
update public.web_hosting_state set last_seen_at = now() - interval '10 minutes';
select is(public.run_probes(), 1, 'agent silencieux : sonde relancée dès 55 s');

-- Garde-fous sur les URL
delete from public.probe_results; delete from public.tests_calls; delete from public.probe_requests;
update public.web_hostings set probe_url = 'https://192.168.1.1/x' where name = 'H1';
update public.web_hostings set probe_url = 'https://serveur.local/x' where name = 'H2';
select is(public.run_probes(), 0, 'adresses IP et noms locaux ne sont jamais sondés');
update public.web_hostings set probe_url = 'https://localhost/x' where name = 'H2';
select is(public.run_probes(), 0, 'localhost n''est jamais sondé');

-- ============================ Purge des sondes ============================================================
insert into public.probe_results (web_hosting_id, ts, ok) values ('00000000-0000-0000-0000-0000000000a1', now() - interval '15 days', true);
select is((public.purge_old_data(8, 400) ->> 'probes_deleted')::int, 1, 'la purge supprime les sondes de plus de 14 jours');

-- ============================ Droits et RLS ===============================================================
select public.tests_fresh();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}', true);
select is((select count(*)::int from public.alert_rules), 8, 'le propriétaire lit les règles de son workspace uniquement');
select is((select count(*)::int from public.cloud_status), 1, 'le propriétaire lit le statut de ses Clouds');
select lives_ok($$insert into public.alert_rules (workspace_id, cloud_server_id, metric, warn_threshold, crit_threshold, window_minutes,
  min_breach_ratio, recover_margin, recover_minutes) select workspace_id, id, 'cpu_pct', 70, 85, 5, 0.8, 5, 5 from public.cloud_servers
  where id = '00000000-0000-0000-0000-0000000000c1'$$, 'le propriétaire crée une surcharge pour son Cloud');
select throws_ok($$insert into public.alert_rules (workspace_id, cloud_server_id, metric, warn_threshold, crit_threshold, window_minutes,
  min_breach_ratio, recover_margin, recover_minutes) select workspace_id, id, 'mem_used_pct', 90, 90, 5, 0.8, 5, 5 from public.cloud_servers
  where id = '00000000-0000-0000-0000-0000000000c1'$$, '23514', null, 'seuil critique <= seuil warning refusé');
select throws_ok($$insert into public.alert_rules (workspace_id, cloud_server_id, metric, warn_threshold, crit_threshold, window_minutes,
  min_breach_ratio, recover_margin, recover_minutes) select workspace_id, id, 'mem_used_pct', 80, 90, 5, 1.5, 5, 5 from public.cloud_servers
  where id = '00000000-0000-0000-0000-0000000000c1'$$, '23514', null, 'ratio hors de [0,1 ; 1] refusé');
select throws_ok($$insert into public.alert_rules (workspace_id, cloud_server_id, metric, warn_threshold, crit_threshold, window_minutes,
  min_breach_ratio, recover_margin, recover_minutes) select workspace_id, id, 'nimporte', 80, 90, 5, 0.8, 5, 5 from public.cloud_servers
  where id = '00000000-0000-0000-0000-0000000000c1'$$, '23514', null, 'métrique inconnue refusée');
select throws_ok($$insert into public.alert_rules (workspace_id, cloud_server_id, metric, warn_threshold, crit_threshold, window_minutes,
  min_breach_ratio, recover_margin, recover_minutes) select workspace_id, '00000000-0000-0000-0000-0000000000c2', 'cpu_pct', 70, 85, 5, 0.8, 5, 5
  from public.cloud_servers where id = '00000000-0000-0000-0000-0000000000c1'$$, '42501', null, 'surcharge sur le Cloud d''un autre workspace refusée');
select lives_ok($$update public.alert_rules set warn_threshold = 65 where metric = 'cpu_pct' and cloud_server_id is not null$$, 'le propriétaire modifie un seuil');
select throws_ok($$update public.alert_rules set metric = 'load1' where metric = 'cpu_pct'$$, '42501', null, 'la métrique d''une règle n''est pas modifiable');
select throws_ok($$insert into public.cloud_status (cloud_server_id, workspace_id, status, status_since, evaluated_at)
  select id, workspace_id, 'normal', now(), now() from public.cloud_servers limit 1$$, '42501', null, 'aucune écriture directe de statut');
select throws_ok($$update public.alert_state set level = 'ok'$$, '42501', null, 'aucune écriture directe d''état de règle');
select is(public.refresh_statuses(), 1, 'le propriétaire peut recalculer les statuts de ses Clouds');
select throws_ok($$select public.evaluate_all()$$, '42501', null, 'evaluate_all est réservé au planificateur');
select throws_ok($$select public.run_probes()$$, '42501', null, 'run_probes est réservé au planificateur');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated","aal":"aal2"}', true);
select is((select count(*)::int from public.alert_rules), 9, 'le lecteur lit les règles');
select throws_ok($$insert into public.alert_rules (workspace_id, metric, warn_threshold, crit_threshold, window_minutes, min_breach_ratio,
  recover_margin, recover_minutes) select id, 'load1', 1, 2, 5, 0.8, 0, 5 from public.workspaces where name <> 'Autre'$$, '42501', null, 'le lecteur ne crée pas de règle');
select is(public.refresh_statuses(), 0, 'le lecteur ne recalcule rien');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","aal":"aal2"}', true);
select is((select count(*)::int from public.alert_rules) + (select count(*)::int from public.cloud_status)
        + (select count(*)::int from public.probe_results), 0, 'un étranger ne voit ni règles, ni statuts, ni sondes');
select is((select count(*)::int from public.get_metric_percentiles('00000000-0000-0000-0000-0000000000c1', 7)), 0, 'ni distribution des mesures');

reset role;
set local role anon;
select throws_ok($$select * from public.cloud_status$$, '42501', null, 'anonyme : pas de lecture des statuts');
select throws_ok($$select public.refresh_statuses()$$, '42501', null, 'anonyme : pas de recalcul');

select * from finish();
rollback;
