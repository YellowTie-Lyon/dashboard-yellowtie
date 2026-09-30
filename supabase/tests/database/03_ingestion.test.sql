-- Tests pgTAP : authentification des agents, validation, rate limit, ingestion, RLS de lecture.
begin;
select plan(50);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.test'),   -- 1er utilisateur : propriétaire
  ('00000000-0000-0000-0000-00000000000b', 'b@example.test');   -- étranger

-- Inventaire de test créé en superutilisateur (cpu_cores et hostname du Cloud volontairement vides).
insert into public.cloud_servers (id, workspace_id, name, slug)
select '00000000-0000-0000-0000-0000000000c1', id, 'Cloud 1', 'cloud-1' from public.workspaces;
insert into public.web_hostings (id, cloud_server_id, name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'H1'),   -- collecteur (auto)
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1', 'H2');
insert into public.web_hostings (id, cloud_server_id, name, is_active) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000c1', 'H3', false),
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000c1', 'H4', true);

-- Tokens : ikh_<id>_<secret> ; seul le SHA-256 du secret est en base.
insert into public.web_hosting_credentials (web_hosting_id, token_hash)
select id, sha256(convert_to(repeat(substr('abcd', n, 1), 64), 'UTF8'))
from (values ('00000000-0000-0000-0000-0000000000a1'::uuid, 1), ('00000000-0000-0000-0000-0000000000a2', 2),
             ('00000000-0000-0000-0000-0000000000a3', 3), ('00000000-0000-0000-0000-0000000000a4', 4)) v(id, n);
update public.web_hostings set token_public_id = repeat(substr('abcd', 1, 1), 12), token_active = true where name = 'H1';
update public.web_hostings set token_public_id = repeat(substr('abcd', 2, 1), 12), token_active = true where name = 'H2';
update public.web_hostings set token_public_id = repeat(substr('abcd', 3, 1), 12), token_active = true where name = 'H3';
update public.web_hostings set token_public_id = repeat(substr('abcd', 4, 1), 12), token_active = false where name = 'H4';  -- révoqué

-- Aides
create function public.tests_token(_n int) returns text language sql as
$$ select 'ikh_' || repeat(substr('abcd', _n, 1), 12) || '_' || repeat(substr('abcd', _n, 1), 64) $$;
create function public.tests_point(_age_s int default 60) returns jsonb language sql as $$
  select jsonb_build_object('ts', extract(epoch from now())::bigint - _age_s, 'cpu_cores', 12,
    'load', jsonb_build_array(2.4, 3.1, 4.1), 'cpu_pct', 15.1,
    'mem', jsonb_build_object('total_mb', 36093, 'used_mb', 11937, 'avail_mb', 24156),
    'swap', jsonb_build_object('total_mb', 4095, 'used_mb', 0),
    'disk', jsonb_build_object('device', '/dev/mapper/vgdata-client', 'total_mb', 281600,
                               'used_mb', 141757, 'avail_mb', 139843),
    'uptime_s', 1000) $$;
create function public.tests_payload(_points jsonb, _hostname text default 'od-34b55c', _v int default 1)
returns jsonb language sql as $$
  select jsonb_build_object('v', _v, 'agent_version', '0.1.0', 'hostname', _hostname,
    'agent', jsonb_build_object('backlog', 0, 'log', jsonb_build_object('size', 123, 'inode', 456)),
    'points', _points) $$;
create function public.tests_hb(_token text, _payload jsonb) returns jsonb language plpgsql as $$
begin
  perform set_config('request.headers', jsonb_build_object('x-agent-token', _token)::text, true);
  return public.agent_heartbeat(_payload);
end $$;
create function public.tests_backdate() returns void language sql security definer as
$$ update public.web_hosting_state set last_seen_at = now() - interval '1 minute' $$;
create table public.tests_res (label text, r jsonb);
grant all on public.tests_res to anon;

set local role anon;

-- ============================ Contrat PostgREST ==================================================
-- PostgREST n'envoie le corps JSON entier qu'à une fonction à UN SEUL paramètre jsonb SANS NOM.
select is((select proargnames from pg_proc where proname = 'agent_heartbeat' and pronamespace = 'public'::regnamespace),
          null, 'agent_heartbeat a un paramètre sans nom (exigence PostgREST pour recevoir tout le corps)');
select is((select pronargs::int from pg_proc where proname = 'agent_heartbeat' and pronamespace = 'public'::regnamespace),
          1, 'agent_heartbeat n''a qu''un seul paramètre');
set local role anon;
select throws_ok($$select public.agent_heartbeat_impl('{"v":1}'::jsonb)$$, '42501', null,
  'la fonction interne n''est pas appelable par les clients');

-- ============================ Authentification ===================================================
select throws_ok($$select public.agent_heartbeat('{"v":1}'::jsonb)$$, 'PT401', 'unauthorized', 'sans header : 401');
select throws_ok($$select public.tests_hb('nimportequoi', public.tests_payload('[]'))$$, 'PT401', null, 'format de token invalide : 401');
select throws_ok(
  $$select public.tests_hb('ikh_' || repeat('a', 12) || '_' || repeat('f', 64), public.tests_payload('[]'))$$,
  'PT401', null, 'mauvais secret : 401');
select throws_ok(
  $$select public.tests_hb('ikh_' || repeat('9', 12) || '_' || repeat('a', 64), public.tests_payload('[]'))$$,
  'PT401', null, 'identifiant inconnu : 401');
select throws_ok($$select public.tests_hb(public.tests_token(4), public.tests_payload('[]'))$$, 'PT401', null,
  'token révoqué : 401');
select throws_ok($$select public.tests_hb(public.tests_token(3), public.tests_payload('[]'))$$, 'PT403', null,
  'hébergement désactivé : 403');

-- ============================ Ingestion (collecteur) =============================================
insert into public.tests_res
select 'hb1', public.tests_hb(public.tests_token(1), public.tests_payload(jsonb_build_array(public.tests_point(60))));
select is((select r ->> 'ok' from public.tests_res where label = 'hb1'), 'true', 'heartbeat valide accepté');
select is((select r ->> 'accepted' from public.tests_res where label = 'hb1'), '1', 'un point accepté');
select is((select r ->> 'collector' from public.tests_res where label = 'hb1'), 'true', 'le serveur indique le rôle de collecteur');
select is((select r -> 'actions' from public.tests_res where label = 'hb1'), '[]'::jsonb, 'aucune action pour l''instant');
select throws_ok($$select public.tests_hb(public.tests_token(1), public.tests_payload('[]'))$$, 'PT429', null,
  'deuxième heartbeat immédiat : 429');

reset role;
select is((select count(*)::int from public.metrics), 1, 'un relevé stocké');
select is((select load1_per_core::numeric from public.metrics), 0.2, 'load par cœur calculé (2,4 / 12)');
select is((select mem_used_pct::numeric from public.metrics), 33.1, 'RAM utilisée en % calculée');
select is((select disk_used_pct::numeric from public.metrics), 50.3, 'disque utilisé en % calculé');
select is((select collected_by_hosting_id from public.metrics), '00000000-0000-0000-0000-0000000000a1'::uuid,
  'le relevé est attribué à l''hébergement authentifié');
select is((select hostname from public.cloud_servers where slug = 'cloud-1'), 'od-34b55c', 'le Cloud apprend son hostname');
select is((select cpu_cores from public.cloud_servers where slug = 'cloud-1'), 12, 'le Cloud apprend son nombre de cœurs');
select is((select agent_version || ':' || log_size_bytes || ':' || log_inode from public.web_hosting_state
            where web_hosting_id = '00000000-0000-0000-0000-0000000000a1'), '0.1.0:123:456', 'état de l''agent enregistré');
select is((select last_point ->> 'cpu_pct' from public.cloud_server_state), '15.1', 'dernier relevé disponible pour le dashboard');

-- ============================ Rejeu, points invalides, ancien point ==============================
select public.tests_backdate();
set local role anon;
insert into public.tests_res
select 'replay', public.tests_hb(public.tests_token(1), public.tests_payload(jsonb_build_array(public.tests_point(60))));
reset role;
select is((select r ->> 'accepted' from public.tests_res where label = 'replay'), '1', 'rejeu du même point accepté');
select is((select count(*)::int from public.metrics), 1, 'rejeu idempotent : pas de doublon');

select public.tests_backdate();
set local role anon;
insert into public.tests_res
select 'mixed', public.tests_hb(public.tests_token(1), public.tests_payload(jsonb_build_array(
  public.tests_point(120),                                              -- valide (et plus ancien)
  jsonb_set(public.tests_point(180), '{cpu_pct}', '150'),               -- cpu > 100
  public.tests_point(90000),                                            -- plus de 24 h
  jsonb_set(public.tests_point(240), '{mem,used_mb}', '99999999'),      -- used > total
  '"pas un objet"'::jsonb,
  public.tests_point(300) - 'mem'                                       -- champ manquant
)));
reset role;
select is((select r ->> 'accepted' from public.tests_res where label = 'mixed'), '1', 'un seul point valide accepté');
select is((select r ->> 'rejected' from public.tests_res where label = 'mixed'), '5', 'cinq points invalides ignorés (sans bloquer)');
select is((select count(*)::int from public.metrics), 2, 'les points invalides ne sont pas stockés');
select is((select extract(epoch from last_metrics_at)::bigint from public.cloud_server_state),
          (select max(extract(epoch from ts))::bigint from public.metrics),
          'un point plus ancien ne fait pas reculer le dernier relevé');

select public.tests_backdate();
set local role anon;
insert into public.tests_res
select 'nullcpu', public.tests_hb(public.tests_token(1), public.tests_payload(jsonb_build_array(
  jsonb_set(public.tests_point(30), '{cpu_pct}', 'null'))));
reset role;
select is((select cpu_pct from public.metrics order by ts desc limit 1), null, 'cpu_pct nul (premier relevé) accepté');

-- ============================ Non-collecteur, hostname, structure ================================
select public.tests_backdate();
set local role anon;
insert into public.tests_res
select 'h2points', public.tests_hb(public.tests_token(2), public.tests_payload(jsonb_build_array(public.tests_point(20))));
reset role;
select is((select r ->> 'collector' from public.tests_res where label = 'h2points'), 'false', 'H2 n''est pas collecteur');
select is((select r ->> 'accepted' from public.tests_res where label = 'h2points'), '0', 'points d''un non-collecteur ignorés');
select is((select count(*)::int from public.metrics), 3, 'aucun relevé ajouté par un non-collecteur');
select is((select anomaly from public.web_hosting_state where web_hosting_id = '00000000-0000-0000-0000-0000000000a2'),
          'points_ignored', 'anomalie enregistrée');

select public.tests_backdate();
set local role anon;
select lives_ok($$select public.tests_hb(public.tests_token(2), public.tests_payload('[]', 'autre-machine'))$$,
  'heartbeat avec un autre hostname accepté');
reset role;
select is((select anomaly from public.web_hosting_state where web_hosting_id = '00000000-0000-0000-0000-0000000000a2'),
          'hostname_mismatch', 'hostname différent de celui du Cloud signalé');

select public.tests_backdate();
set local role anon;
select throws_ok($$select public.tests_hb(public.tests_token(1), public.tests_payload('[]', 'od-34b55c', 2))$$,
  'PT400', null, 'version de protocole inconnue : 400');
select throws_ok($$select public.tests_hb(public.tests_token(1), '{"v":1,"points":{}}')$$, 'PT400', null,
  'points non tableau : 400');
select throws_ok(
  $$select public.tests_hb(public.tests_token(1),
      public.tests_payload((select jsonb_agg(public.tests_point(i)) from generate_series(1, 31) i)))$$,
  'PT400', null, 'plus de 30 points : 400');
select throws_ok($$select public.tests_hb(public.tests_token(1), '[1,2]'::jsonb)$$, 'PT400', null, 'payload non objet : 400');

-- ============================ Rotation avec période de grâce =====================================
reset role;
update public.web_hosting_credentials
   set prev_token_hash = sha256(convert_to(repeat('e', 64), 'UTF8')),
       prev_token_expires_at = now() + interval '1 hour'
 where web_hosting_id = '00000000-0000-0000-0000-0000000000a1';
select public.tests_backdate();
set local role anon;
select lives_ok(
  $$select public.tests_hb('ikh_' || repeat('a', 12) || '_' || repeat('e', 64), public.tests_payload('[]'))$$,
  'ancien token accepté pendant la période de grâce');
reset role;
update public.web_hosting_credentials set prev_token_expires_at = now() - interval '1 second'
 where web_hosting_id = '00000000-0000-0000-0000-0000000000a1';
select public.tests_backdate();
set local role anon;
select throws_ok(
  $$select public.tests_hb('ikh_' || repeat('a', 12) || '_' || repeat('e', 64), public.tests_payload('[]'))$$,
  'PT401', null, 'ancien token refusé après la période de grâce');

-- ============================ RLS de lecture =====================================================
select throws_ok($$select * from public.metrics$$, '42501', null, 'anonyme : pas de lecture des métriques');
select throws_ok($$select * from public.cloud_server_state$$, '42501', null, 'anonyme : pas de lecture de l''état');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}', true);
select is((select count(*)::int from public.metrics), 3, 'le propriétaire lit les métriques');
select is((select count(*)::int from public.cloud_server_state), 1, 'le propriétaire lit l''état du Cloud');
select is((select count(*)::int from public.web_hosting_state), 2, 'le propriétaire lit l''état des agents');
select throws_ok($$insert into public.metrics (cloud_server_id, ts) values (gen_random_uuid(), now())$$, '42501', null,
  'aucune écriture de métriques depuis le client');
select throws_ok($$update public.web_hosting_state set anomaly = null$$, '42501', null,
  'aucune écriture d''état depuis le client');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","aal":"aal2"}', true);
select is((select count(*)::int from public.metrics) + (select count(*)::int from public.cloud_server_state)
        + (select count(*)::int from public.web_hosting_state), 0, 'un étranger ne voit aucune métrique');

select * from finish();
rollback;
