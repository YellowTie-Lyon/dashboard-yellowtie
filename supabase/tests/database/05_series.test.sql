-- Tests pgTAP : agrégation horaire, purge, get_series (sources, finesse, conservation, RLS).
begin;
select plan(31);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.test'),   -- propriétaire
  ('00000000-0000-0000-0000-00000000000b', 'b@example.test');   -- étranger
insert into public.cloud_servers (id, workspace_id, name, slug, cpu_cores)
select '00000000-0000-0000-0000-0000000000c1', id, 'Cloud 1', 'cloud-1', 12 from public.workspaces;

-- Relevés : les 5 dernières heures COMPLÈTES, 1 par minute. Heure k (1..5) : load1 = k + minute/100,
-- donc pic = k + 0,59 et moyenne = k + 0,295 ; cpu_pct nul sur l'heure 5 (aucun CPU calculable).
-- Repère : début de chaque heure = date_bin(1 h), comme dans la fonction.
create function public.tests_hour(_k int) returns timestamptz language sql stable as
$$ select date_bin(interval '1 hour', now(), timestamptz '2000-01-01 00:00:00+00') - make_interval(hours => _k) $$;
insert into public.metrics (cloud_server_id, ts, cpu_cores, load1, load5, load15, load1_per_core, load5_per_core, cpu_pct,
  mem_total_mb, mem_used_mb, mem_avail_mb, mem_used_pct, swap_total_mb, swap_used_mb, swap_used_pct,
  disk_total_mb, disk_used_mb, disk_avail_mb, disk_used_pct, uptime_s)
select '00000000-0000-0000-0000-0000000000c1', public.tests_hour(k) + make_interval(mins => j), 12,
       k + j / 100.0, 2, 3, 0.1, 0.2, case when k = 5 then null else 10 + k end,
       1000, 400, 600, 40, 100, 10, 10, 1000, 500, 500, 50, 1000
from generate_series(1, 5) k, generate_series(0, 59) j;
-- Anciens relevés (10 jours) : 30 lignes dans une même heure
insert into public.metrics (cloud_server_id, ts, cpu_cores, load1, load5, load15, load1_per_core, load5_per_core, cpu_pct,
  mem_total_mb, mem_used_mb, mem_avail_mb, mem_used_pct, swap_total_mb, swap_used_mb, swap_used_pct,
  disk_total_mb, disk_used_mb, disk_avail_mb, disk_used_pct, uptime_s)
select '00000000-0000-0000-0000-0000000000c1',
       date_bin(interval '1 hour', now() - interval '10 days', timestamptz '2000-01-01 00:00:00+00') + make_interval(mins => j),
       12, 7, 2, 3, 0.1, 0.2, 50, 1000, 400, 600, 40, 100, 10, 10, 1000, 500, 500, 50, 1000
from generate_series(0, 29) j;

-- ============================ Agrégation ==========================================================
select ok(public.rollup_metrics(interval '11 days') > 0, 'l''agrégation produit des heures');
select is((select count(*)::int from public.metrics_1h), 6, 'une ligne par heure agrégée (5 récentes + 1 ancienne)');
select is((select n from public.metrics_1h where ts = public.tests_hour(3)), 60, 'n = nombre de relevés de l''heure');
select is((select load1_max from public.metrics_1h where ts = public.tests_hour(3)), 3.59::real, 'le pic (maximum) est conservé');
select is((select round(load1_avg::numeric, 3) from public.metrics_1h where ts = public.tests_hour(3)), 3.295, 'la moyenne est exacte');
select is((select cpu_pct_avg from public.metrics_1h where ts = public.tests_hour(5)), null, 'CPU nul quand aucun relevé n''a de CPU');
select is((select cpu_pct_avg from public.metrics_1h where ts = public.tests_hour(2)), 12::real, 'la moyenne du CPU ignore les valeurs nulles');
select is(public.rollup_metrics(interval '11 days') > 0, true, 'agrégation relançable');
select is((select count(*)::int from public.metrics_1h), 6, 'idempotente : aucun doublon');
select is((select detail ->> 'buckets' from public.job_state where name = 'rollup')::int > 0, true,
          'la dernière exécution est enregistrée');

-- ============================ get_series (propriétaire) ===========================================
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);

select is((select count(*)::int from public.get_series('00000000-0000-0000-0000-0000000000c1', '6h')),
          (select count(*)::int from public.metrics where ts >= now() - interval '6 hours'),
          '6h : un point par relevé');
select is((select count(*)::int from public.get_series('00000000-0000-0000-0000-0000000000c1', '1h')),
          (select count(*)::int from public.metrics where ts >= now() - interval '1 hour'), '1h : un point par relevé');
select is((select bool_and(n = 1 and load1_avg = load1_max) from public.get_series('00000000-0000-0000-0000-0000000000c1', '1h')),
          true, 'sur les relevés bruts, moyenne = pic');
select is((select sum(n)::int from public.get_series('00000000-0000-0000-0000-0000000000c1', '24h')),
          (select count(*)::int from public.metrics where ts >= now() - interval '24 hours'),
          '24h : conservation, la somme des tranches = les relevés');
select ok((select max(n) <= 5 from public.get_series('00000000-0000-0000-0000-0000000000c1', '24h')), '24h : tranches de 5 minutes');
select is((select sum(n)::int from public.get_series('00000000-0000-0000-0000-0000000000c1', '7d')),
          (select count(*)::int from public.metrics where ts >= now() - interval '7 days'), '7d : conservation');
select ok((select max(n) <= 15 from public.get_series('00000000-0000-0000-0000-0000000000c1', '7d')), '7d : tranches de 15 minutes');
select is((select sum(n)::int from public.get_series('00000000-0000-0000-0000-0000000000c1', '30d')),
          (select count(*)::int from public.metrics), '30d : conservation (agrégats + heure en cours à la volée)');
select ok((select max(n) <= 60 from public.get_series('00000000-0000-0000-0000-0000000000c1', '30d')), '30d : tranches d''une heure');
select is((select count(*)::int from public.get_series('00000000-0000-0000-0000-0000000000c1', '30d')), 6,
          '30d : 6 heures de données, aucune heure en double entre agrégats et volée');
select throws_ok($$select * from public.get_series('00000000-0000-0000-0000-0000000000c1', '2h')$$, '22023', null,
                 'période inconnue refusée');

-- ============================ Purge ===============================================================
reset role;
select throws_ok($$select public.purge_old_data(3, 400)$$, '22023', null, 'garde-fou : purge sous 8 jours refusée');
select is((select (public.purge_old_data(8, 400) ->> 'raw_deleted')::int), 30, 'la purge supprime les relevés bruts anciens');
select is((select count(*)::int from public.metrics where ts < now() - interval '8 days'), 0, 'plus de relevé brut de plus de 8 jours');
select is((select count(*)::int from public.metrics_1h), 6, 'les agrégats horaires survivent à la purge des relevés');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select is((select coalesce(sum(n), 0)::int from public.get_series('00000000-0000-0000-0000-0000000000c1', '30d')
            where ts < now() - interval '8 days'), 30, '30d : l''ancien pic reste visible via l''agrégat horaire');

-- ============================ RLS et droits =======================================================
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
select is((select count(*)::int from public.get_series('00000000-0000-0000-0000-0000000000c1', '30d')), 0,
          'un étranger ne voit aucun point');
select throws_ok($$select public.rollup_metrics()$$, '42501', null, 'un client ne peut pas lancer l''agrégation');
select throws_ok($$select public.purge_old_data()$$, '42501', null, 'un client ne peut pas lancer la purge');
select throws_ok($$insert into public.metrics_1h (cloud_server_id, ts, n) values (gen_random_uuid(), now(), 1)$$, '42501', null,
                 'aucune écriture d''agrégat depuis le client');
reset role;
set local role anon;
select throws_ok($$select * from public.get_series('00000000-0000-0000-0000-0000000000c1', '1h')$$, '42501', null,
                 'anonyme : pas de lecture des séries');

select * from finish();
rollback;
