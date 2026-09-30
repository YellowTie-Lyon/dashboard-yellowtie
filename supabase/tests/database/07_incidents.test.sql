-- Tests pgTAP : cycle de vie des incidents, chronologie, types, réglage de clôture, séries sur fenêtre, droits.
-- NB : now() est constant dans une transaction ; les dates sont donc reculées explicitement quand il le faut.
begin;
select plan(87);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.test'),   -- propriétaire
  ('00000000-0000-0000-0000-00000000000b', 'b@example.test'),   -- étranger
  ('00000000-0000-0000-0000-00000000000c', 'c@example.test');   -- lecteur
insert into public.workspace_members (workspace_id, user_id, role)
select id, '00000000-0000-0000-0000-00000000000c', 'viewer' from public.workspaces;
insert into public.cloud_servers (id, workspace_id, name, slug, cpu_cores)
select '00000000-0000-0000-0000-0000000000c1', id, 'Cloud 1', 'cloud-1', 12 from public.workspaces;
insert into public.web_hostings (id, cloud_server_id, name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'H1'),   -- collecteur
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
  select id, workspace_id, now(), now(), '{"cpu_pct": 12}'::jsonb from public.cloud_servers where id = '00000000-0000-0000-0000-0000000000c1'
  on conflict (cloud_server_id) do update set last_received_at = now(), last_metrics_at = now();
  insert into public.web_hosting_state (web_hosting_id, workspace_id, last_seen_at)
  select id, workspace_id, now() from public.web_hostings where cloud_server_id = '00000000-0000-0000-0000-0000000000c1'
  on conflict (web_hosting_id) do update set last_seen_at = now();
$$;
create function public.tests_eval() returns void language sql as
$$ select public.evaluate_cloud('00000000-0000-0000-0000-0000000000c1') $$;
create function public.tests_open(_kind text) returns int language sql as
$$ select count(*)::int from public.incidents where kind = _kind and status <> 'closed' $$;
create function public.tests_field(_kind text, _field text) returns text language sql as
$$ select to_jsonb(i) ->> _field from public.incidents i where kind = _kind and status <> 'closed' order by started_at desc limit 1 $$;
create function public.tests_events(_kind text) returns text language sql as
$$ select string_agg(e.type, ',' order by e.id) from public.incident_events e
    where e.incident_id = (select id from public.incidents where kind = _kind order by created_at desc, started_at desc limit 1) $$;

-- ============================ Performance : cycle de vie complet ===========================================
select public.tests_fresh();
select public.tests_seed(0.2, 10, 30, 40);
select public.tests_eval();
select is((select count(*)::int from public.incidents), 0, 'aucun incident quand tout va bien');

select public.tests_seed(0.7, 10, 30, 40);
select public.tests_eval();
select is(public.tests_open('performance'), 1, 'un incident de performance s''ouvre au premier Warning');
select is(public.tests_field('performance', 'status'), 'warning', 'statut Warning');
select is(public.tests_field('performance', 'severity_max'), 'warning', 'gravité maximale Warning');
select is((select reasons -> 0 ->> 'metric' from public.incidents where kind = 'performance'), 'load1_per_core', 'la raison est enregistrée');
select ok((select start_snapshot ->> 'cpu_pct' = '12' from public.incidents where kind = 'performance'), 'le dernier relevé est conservé à l''ouverture');
select is(public.tests_events('performance'), 'opened', 'chronologie : ouverture');
select public.tests_eval();
select is((select count(*)::int from public.incidents), 1, 're-évaluation : jamais de doublon');
select is(public.tests_events('performance'), 'opened', 're-évaluation : aucun événement en double');

select public.tests_seed(1.2, 10, 30, 40);
select public.tests_eval();
select is(public.tests_field('performance', 'status'), 'critical', 'escalade Warning -> Critical');
select is(public.tests_field('performance', 'severity_max'), 'critical', 'gravité maximale Critical');
select is((select (peak ->> 'load1_per_core')::float from public.incidents where kind = 'performance'), 1.2::float, 'le pic est mémorisé');
select is(public.tests_events('performance'), 'opened,escalated', 'chronologie : escalade');

select public.tests_seed(0.95, 10, 30, 40);
select public.tests_eval();
select is(public.tests_field('performance', 'status'), 'critical', 'hystérésis : le Critical est maintenu à 0,95');
select is(public.tests_events('performance'), 'opened,escalated', 'aucun événement tant que rien ne change');

select public.tests_seed(0.75, 10, 30, 40);
select public.tests_eval();
select is(public.tests_field('performance', 'status'), 'warning', 'désescalade Critical -> Warning');
select is(public.tests_field('performance', 'severity_max'), 'critical', 'la gravité maximale reste Critical');
select is(public.tests_events('performance'), 'opened,escalated,deescalated', 'chronologie : désescalade enregistrée');
select is((select (peak ->> 'load1_per_core')::float from public.incidents where kind = 'performance'), 1.2::float, 'le pic n''est pas écrasé par une valeur plus basse');

select public.tests_seed(0.4, 10, 30, 40);
select public.tests_eval();
select is(public.tests_field('performance', 'status'), 'recovery', 'retour à la normale : Recovery');
select isnt(public.tests_field('performance', 'recovery_since'), null, 'début du retour enregistré');
select is(public.tests_open('performance'), 1, 'toujours ouvert pendant la confirmation');

select public.tests_seed(0.7, 10, 30, 40);
select public.tests_eval();
select is(public.tests_field('performance', 'status'), 'warning', 'rechute pendant le retour : même incident, de nouveau Warning');
select is(public.tests_field('performance', 'recovery_since'), null, 'le minuteur de retour est annulé');
select is((select count(*)::int from public.incidents), 1, 'la rechute ne crée pas de nouvel incident');
select is(public.tests_events('performance'), 'opened,escalated,deescalated,recovery_started,relapse', 'chronologie : rechute');

-- Clôture : après le délai de confirmation (5 min par défaut) ; la durée s'arrête au début du retour stable
select public.tests_seed(0.4, 10, 30, 40);
select public.tests_eval();
update public.incidents set started_at = now() - interval '1 hour', recovery_since = now() - interval '10 minutes' where kind = 'performance';
update public.settings set value = '30'::jsonb where key = 'incident_close_minutes';
select public.tests_eval();
select is(public.tests_field('performance', 'status'), 'recovery', 'délai de clôture réglé à 30 min : pas encore clos après 10 min');
update public.settings set value = '5'::jsonb where key = 'incident_close_minutes';
select public.tests_eval();
select is(public.tests_open('performance'), 0, 'délai de 5 min écoulé : incident clos');
select is((select status from public.incidents where kind = 'performance'), 'closed', 'statut Clos');
select ok((select ended_at = now() - interval '10 minutes' from public.incidents where kind = 'performance'), 'la fin est le début du retour stable, pas la confirmation');
select is((select (data ->> 'duration_seconds')::int from public.incident_events where type = 'closed'), 3000, 'durée enregistrée : 50 min');
select is(public.tests_events('performance'), 'opened,escalated,deescalated,recovery_started,relapse,recovery_started,closed', 'chronologie complète');

select public.tests_seed(0.7, 10, 30, 40);
select public.tests_eval();
select is((select count(*)::int from public.incidents where kind = 'performance'), 2, 'un nouveau dépassement après clôture ouvre un nouvel incident');
select is(public.tests_open('performance'), 1, 'un seul incident ouvert');

-- ============================ Regroupement : un seul incident « performance », un incident « disque » ======
delete from public.incidents; delete from public.alert_state;
select public.tests_seed(0.7, 95, 96, 40);
select public.tests_eval();
select is(public.tests_open('performance'), 1, 'load + CPU + RAM : un seul incident de performance');
select is((select jsonb_array_length(reasons) from public.incidents where kind = 'performance'), 3, 'les trois raisons sont réunies');
select is(public.tests_field('performance', 'severity_max'), 'critical', 'la gravité est la plus haute des raisons');
select is(public.tests_open('disk'), 0, 'le disque n''alerte pas quand il est bas');
select public.tests_seed(0.2, 10, 30, 85);
select public.tests_eval();
select is(public.tests_open('disk'), 1, 'le disque a son propre incident');
select is(public.tests_field('disk', 'severity_max'), 'warning', 'disque à 85 % : Warning');
select is(public.tests_open('performance'), 1, 'l''incident de performance existe toujours (en retour)');
select is(public.tests_field('performance', 'status'), 'recovery', 'les métriques de performance sont revenues : Recovery');

-- Maintenance : rien ne bouge
update public.cloud_servers set maintenance = true where id = '00000000-0000-0000-0000-0000000000c1';
select public.tests_seed(0.2, 10, 30, 95);
select public.tests_eval();
select is(public.tests_field('disk', 'status'), 'warning', 'en maintenance, l''incident existant est figé');
update public.cloud_servers set maintenance = false where id = '00000000-0000-0000-0000-0000000000c1';

-- ============================ Offline ======================================================================
delete from public.incidents; delete from public.alert_state;
select public.tests_seed(0.7, 10, 30, 40);
select public.tests_eval();
update public.web_hosting_state set last_seen_at = now() - interval '10 minutes';
update public.cloud_server_state set last_received_at = now() - interval '10 minutes';
select public.tests_eval();
select is(public.tests_open('offline'), 1, 'aucun agent depuis 10 min : incident offline');
select is(public.tests_field('offline', 'severity_max'), 'critical', 'offline : Critical');
select is(public.tests_field('offline', 'diagnosis'), 'unknown_cause', 'diagnostic prudent enregistré');
select is(public.tests_open('agent'), 0, 'pas d''incident « agent » quand tout le Cloud est silencieux');
select is(public.tests_field('performance', 'status'), 'warning', 'l''incident de performance est conservé tel quel pendant le silence');

select public.tests_fresh();
select public.tests_eval();
select is(public.tests_field('offline', 'status'), 'recovery', 'les agents reviennent : incident offline en Recovery');
select is(public.tests_events('offline'), 'opened,recovery_started', 'chronologie offline');

-- ============================ Agents ======================================================================
delete from public.incidents; delete from public.alert_state;
select public.tests_seed(0.2, 10, 30, 40);
select public.tests_fresh();
update public.web_hosting_state set last_seen_at = now() - interval '10 minutes' where web_hosting_id = '00000000-0000-0000-0000-0000000000a2';
select public.tests_eval();
select is(public.tests_open('agent'), 1, 'un agent silencieux, les autres vivants : incident « agent »');
select is((select web_hosting_id from public.incidents where kind = 'agent'), '00000000-0000-0000-0000-0000000000a2'::uuid, 'rattaché à l''hébergement concerné');
select is((select reasons -> 0 ->> 'kind' from public.incidents where kind = 'agent'), 'silent', 'raison : agent silencieux');
select is(public.tests_open('offline'), 0, 'le Cloud n''est pas offline');
select public.tests_fresh();
select public.tests_eval();
select is(public.tests_field('agent', 'status'), 'recovery', 'l''agent revient : Recovery');

delete from public.incidents;
update public.cloud_server_state set last_received_at = now() - interval '10 minutes';
select public.tests_eval();
select is((select reasons -> 0 ->> 'kind' from public.incidents where kind = 'agent'), 'metrics_stale', 'collecteur vivant mais sans relevé : incident « agent » (valeurs obsolètes)');
select is((select web_hosting_id from public.incidents where kind = 'agent'), '00000000-0000-0000-0000-0000000000a1'::uuid, 'rattaché au collecteur');

delete from public.incidents;
select public.tests_fresh();
update public.web_hosting_state set last_seen_at = now() - interval '10 minutes' where web_hosting_id = '00000000-0000-0000-0000-0000000000a2';
select public.tests_eval();
update public.web_hostings set is_active = false where id = '00000000-0000-0000-0000-0000000000a2';
select public.tests_eval();
select is(public.tests_field('agent', 'status'), 'recovery', 'un hébergement désactivé ne garde pas d''incident ouvert');
update public.web_hostings set is_active = true where id = '00000000-0000-0000-0000-0000000000a2';

-- Contrainte d'unicité
delete from public.incidents; delete from public.alert_state;
insert into public.incidents (workspace_id, cloud_server_id, kind, status, severity_max)
select workspace_id, id, 'disk', 'warning', 'warning' from public.cloud_servers;
select throws_ok($$insert into public.incidents (workspace_id, cloud_server_id, kind, status, severity_max)
  select workspace_id, id, 'disk', 'critical', 'critical' from public.cloud_servers$$, '23505', null,
  'jamais deux incidents ouverts du même type pour un Cloud');
select lives_ok($$insert into public.incidents (workspace_id, cloud_server_id, kind, status, severity_max, ended_at)
  select workspace_id, id, 'disk', 'closed', 'warning', now() from public.cloud_servers$$, 'un incident clos n''empêche pas d''en ouvrir un autre');

-- ============================ Réglages ====================================================================
select is((select value #>> '{}' from public.settings where key = 'incident_close_minutes'), '5', 'délai de clôture par défaut : 5 min');
select throws_ok($$update public.settings set value = '0'::jsonb where key = 'incident_close_minutes'$$, '23514', null, 'délai hors bornes refusé');
select throws_ok($$update public.settings set value = '"cinq"'::jsonb where key = 'incident_close_minutes'$$, '23514', null, 'délai non numérique refusé');
select throws_ok($$insert into public.settings (workspace_id, key, value) select id, 'autre', '1'::jsonb from public.workspaces$$, '23514', null, 'clé inconnue refusée');

-- ============================ Séries sur une fenêtre ======================================================
select public.tests_seed(0.5, 20, 30, 40, 300);   -- 301 relevés sur 5 h
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}', true);
select is((select count(*)::int from public.get_series_window('00000000-0000-0000-0000-0000000000c1', now() - interval '2 hours', now() + interval '1 minute')),
          (select count(*)::int from public.metrics where ts >= now() - interval '2 hours'), 'fenêtre courte : un point par relevé');
select is((select sum(n)::int from public.get_series_window('00000000-0000-0000-0000-0000000000c1', now() - interval '6 hours', now() + interval '1 minute')),
          301, 'fenêtre de 6 h : conservation des relevés');
select ok((select count(*) <= 700 from public.get_series_window('00000000-0000-0000-0000-0000000000c1', now() - interval '3 days', now() + interval '1 minute')),
          'fenêtre longue : au plus 700 points');
select throws_ok($$select * from public.get_series_window('00000000-0000-0000-0000-0000000000c1', now(), now() - interval '1 hour')$$, '22023', null, 'fenêtre inversée refusée');
select throws_ok($$select * from public.get_series_window('00000000-0000-0000-0000-0000000000c1', now() - interval '500 days', now())$$, '22023', null, 'fenêtre de plus de 400 jours refusée');
reset role;
insert into public.metrics_1h (cloud_server_id, ts, n, load1_avg, load1_max, load5_avg, load5_max, load15_avg, load15_max,
  mem_used_pct_avg, mem_used_pct_max, swap_used_pct_avg, swap_used_pct_max, disk_used_pct_avg, disk_used_pct_max)
values ('00000000-0000-0000-0000-0000000000c1', date_bin(interval '1 hour', now() - interval '60 days', timestamptz '2000-01-01 00:00:00+00'),
        60, 3, 5, 3, 3, 3, 3, 30, 31, 10, 10, 40, 40);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}', true);
select is((select n from public.get_series_window('00000000-0000-0000-0000-0000000000c1', now() - interval '61 days', now() - interval '59 days')), 60,
          'avant 34 jours : agrégats horaires');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","aal":"aal2"}', true);
select is((select count(*)::int from public.get_series_window('00000000-0000-0000-0000-0000000000c1', now() - interval '6 hours', now())), 0, 'un étranger ne voit aucun point');

-- ============================ Droits =====================================================================
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}', true);
select is((select count(*)::int from public.incidents), 2, 'le propriétaire lit les incidents');
select ok((select count(*) >= 0 from public.incident_events), 'et leur chronologie');
select lives_ok($$update public.incidents set note = 'Cause : plugin de cache, corrigé' where kind = 'disk' and status = 'warning'$$, 'le propriétaire modifie la note');
select throws_ok($$update public.incidents set status = 'closed' where kind = 'disk'$$, '42501', null, 'le statut n''est pas modifiable par le client');
select throws_ok($$update public.incidents set severity_max = 'critical'$$, '42501', null, 'la gravité n''est pas modifiable par le client');
select throws_ok($$insert into public.incidents (workspace_id, cloud_server_id, kind, status, severity_max)
  select workspace_id, id, 'offline', 'warning', 'warning' from public.cloud_servers$$, '42501', null, 'aucune création d''incident depuis le client');
select throws_ok($$delete from public.incidents$$, '42501', null, 'aucune suppression depuis le client');
select throws_ok($$insert into public.incident_events (incident_id, type) select id, 'closed' from public.incidents limit 1$$, '42501', null, 'aucune écriture dans la chronologie');
select throws_ok($$select public.sync_incident('00000000-0000-0000-0000-0000000000c1', null, 'disk', 'ok', '[]', null)$$, '42501', null, 'la synchronisation est réservée au planificateur');
select lives_ok($$update public.settings set value = '10'::jsonb where key = 'incident_close_minutes'$$, 'le propriétaire règle le délai de clôture');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated","aal":"aal2"}', true);
select is((select count(*)::int from public.incidents), 2, 'le lecteur lit les incidents');
select is((select count(*)::int from (select 1 from public.incidents where note is not null) x), 1, 'le lecteur voit la note');
update public.incidents set note = 'tentative du lecteur';
select is((select count(*)::int from public.incidents where note = 'tentative du lecteur'), 0, 'le lecteur ne modifie aucune note');
update public.settings set value = '99'::jsonb where key = 'incident_close_minutes';
select is((select value #>> '{}' from public.settings where key = 'incident_close_minutes'), '10', 'le lecteur ne modifie pas les réglages');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","aal":"aal2"}', true);
select is((select count(*)::int from public.incidents) + (select count(*)::int from public.incident_events)
        + (select count(*)::int from public.settings), 0, 'un étranger ne voit ni incidents, ni chronologie, ni réglages');
reset role;
set local role anon;
select throws_ok($$select * from public.incidents$$, '42501', null, 'anonyme : pas de lecture des incidents');

select * from finish();
rollback;
