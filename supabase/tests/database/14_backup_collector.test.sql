-- Tests pgTAP : collecteur de secours (relève des relevés système quand le collecteur désigné est étouffé).
begin;
select plan(15);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'a@example.test');
insert into public.cloud_servers (id, workspace_id, name, slug)
select '00000000-0000-0000-0000-0000000000c1', id, 'Cloud 1', 'cloud-1' from public.workspaces;
insert into public.web_hostings (id, cloud_server_id, name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'H1'),   -- collecteur (1er hébergement)
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1', 'H2'),
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000c1', 'H3');
insert into public.web_hosting_credentials (web_hosting_id, token_hash)
select id, sha256(convert_to(repeat(substr('abc', n, 1), 64), 'UTF8'))
from (values ('00000000-0000-0000-0000-0000000000a1'::uuid, 1), ('00000000-0000-0000-0000-0000000000a2', 2), ('00000000-0000-0000-0000-0000000000a3', 3)) v(id, n);
update public.web_hostings set token_public_id = repeat('a', 12), token_active = true where name = 'H1';
update public.web_hostings set token_public_id = repeat('b', 12), token_active = true where name = 'H2';
update public.web_hostings set token_public_id = repeat('c', 12), token_active = true where name = 'H3';

create function public.tests_token(_n int) returns text language sql as
$$ select 'ikh_' || repeat(substr('abc', _n, 1), 12) || '_' || repeat(substr('abc', _n, 1), 64) $$;
create function public.tests_point(_age_s int) returns jsonb language sql as $$
  select jsonb_build_object('ts', extract(epoch from now())::bigint - _age_s, 'cpu_cores', 12, 'load', jsonb_build_array(2.4, 3.1, 4.1), 'cpu_pct', 15.1,
    'mem', jsonb_build_object('total_mb', 36093, 'used_mb', 11937, 'avail_mb', 24156), 'swap', jsonb_build_object('total_mb', 4095, 'used_mb', 0),
    'disk', jsonb_build_object('device', '/dev/x', 'total_mb', 281600, 'used_mb', 141757, 'avail_mb', 139843), 'uptime_s', 1000) $$;
create function public.tests_hb(_n int, _points jsonb) returns jsonb language plpgsql as $$
begin
  perform set_config('request.headers', jsonb_build_object('x-agent-token', public.tests_token(_n))::text, true);
  return public.agent_heartbeat(jsonb_build_object('v', 1, 'agent_version', '0.4.0', 'hostname', 'od-1', 'agent', jsonb_build_object('backlog', 0), 'points', _points));
end $$;
create function public.tests_backdate() returns void language sql security definer as $$ update public.web_hosting_state set last_seen_at = now() - interval '1 minute' $$;
create table public.tests_res (label text, r jsonb);
grant all on public.tests_res to anon;

set local role anon;
-- Situation normale : le collecteur envoie, les autres ne relèvent rien.
insert into public.tests_res select 'c1', public.tests_hb(1, jsonb_build_array(public.tests_point(60)));
select is((select (r ->> 'accepted')::int from public.tests_res where label = 'c1'), 1, 'le collecteur désigné envoie ses relevés');
select public.tests_backdate();
insert into public.tests_res select 'h2a', public.tests_hb(2, '[]'::jsonb);
select is((select r ->> 'collector' from public.tests_res where label = 'h2a'), 'false', 'collecteur en bonne santé : pas de secours');
select public.tests_backdate();
insert into public.tests_res select 'h2b', public.tests_hb(2, jsonb_build_array(public.tests_point(50)));
select is((select (r ->> 'accepted')::int from public.tests_res where label = 'h2b'), 0, 'un autre agent n''envoie pas de relevés tant que le collecteur va bien');

-- Le collecteur se tait depuis 3 minutes.
reset role;
update public.cloud_server_state set collector_last_ts = now() - interval '3 minutes';
select public.tests_backdate();
set local role anon;
insert into public.tests_res select 'h2c', public.tests_hb(2, '[]'::jsonb);
select is((select r ->> 'collector' from public.tests_res where label = 'h2c'), 'true', 'collecteur muet : l''agent élu reçoit le rôle de secours');
select public.tests_backdate();
insert into public.tests_res select 'h3a', public.tests_hb(3, '[]'::jsonb);
select is((select r ->> 'collector' from public.tests_res where label = 'h3a'), 'false', 'un seul agent de secours : les autres ne relèvent rien');
select public.tests_backdate();
insert into public.tests_res select 'h2d', public.tests_hb(2, jsonb_build_array(public.tests_point(40)));
select is((select (r ->> 'accepted')::int from public.tests_res where label = 'h2d'), 1, 'le secours envoie des relevés, acceptés');
select public.tests_backdate();
insert into public.tests_res select 'h3b', public.tests_hb(3, jsonb_build_array(public.tests_point(30)));
select is((select (r ->> 'accepted')::int from public.tests_res where label = 'h3b'), 0, 'un agent non élu reste ignoré');
reset role;
select is((select anomaly from public.web_hosting_state where web_hosting_id = '00000000-0000-0000-0000-0000000000a2'), 'backup_collector', 'l''anomalie « collecteur de secours » est signalée (information)');
select is((select count(*)::int from public.metrics), 2, 'les relevés du secours alimentent bien le Cloud');
select is((select collector_last_ts < now() - interval '2 minutes' from public.cloud_server_state), true, 'les relevés du secours ne rafraîchissent pas la date du collecteur désigné');

-- Le secours reste en place minute après minute (pas d'oscillation).
select public.tests_backdate();
set local role anon;
insert into public.tests_res select 'h2e', public.tests_hb(2, '[]'::jsonb);
select is((select r ->> 'collector' from public.tests_res where label = 'h2e'), 'true', 'le secours garde son rôle tant que le collecteur est muet');

-- Si l'élu se tait à son tour, le suivant prend le relais.
reset role;
update public.web_hosting_state set last_seen_at = now() - interval '5 minutes' where web_hosting_id = '00000000-0000-0000-0000-0000000000a2';
set local role anon;
insert into public.tests_res select 'h3c', public.tests_hb(3, '[]'::jsonb);
select is((select r ->> 'collector' from public.tests_res where label = 'h3c'), 'true', 'agent élu muet : l''agent suivant prend le relais');

-- Le collecteur revient.
insert into public.tests_res select 'c2', public.tests_hb(1, jsonb_build_array(public.tests_point(20)));
select is((select (r ->> 'accepted')::int from public.tests_res where label = 'c2'), 1, 'le collecteur désigné revient');
select public.tests_backdate();
insert into public.tests_res select 'h3d', public.tests_hb(3, '[]'::jsonb);
select is((select r ->> 'collector' from public.tests_res where label = 'h3d'), 'false', 'collecteur revenu : le secours s''arrête');
select public.tests_backdate();
insert into public.tests_res select 'h3e', public.tests_hb(3, jsonb_build_array(public.tests_point(10)));
select is((select (r ->> 'accepted')::int from public.tests_res where label = 'h3e'), 0, 'et ses relevés sont de nouveau ignorés');

select * from finish();
rollback;
