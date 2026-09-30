-- Tests pgTAP : agrégats d'analyse du trafic (agent 0.4.0) — motifs de paramètres, user-agents, IP par domaine, détail par domaine.
begin;
select plan(19);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'a@example.test');
insert into public.cloud_servers (id, workspace_id, name, slug, cpu_cores)
select '00000000-0000-0000-0000-0000000000c1', id, 'Cloud 1', 'cloud-1', 12 from public.workspaces;
insert into public.web_hostings (id, cloud_server_id, name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'H1');
insert into public.web_hosting_credentials (web_hosting_id, token_hash)
values ('00000000-0000-0000-0000-0000000000a1', sha256(convert_to(repeat('a', 64), 'UTF8')));
update public.web_hostings set token_public_id = repeat('a', 12), token_active = true;

create function public.tests_hb(_traffic jsonb) returns jsonb language plpgsql as $$
begin
  perform set_config('request.headers', jsonb_build_object('x-agent-token', 'ikh_' || repeat('a', 12) || '_' || repeat('a', 64))::text, true);
  return public.agent_heartbeat(jsonb_build_object('v', 1, 'agent_version', '0.4.0', 'hostname', 'od-1', 'agent', jsonb_build_object('backlog', 0), 'points', '[]'::jsonb, 'traffic', _traffic));
end $$;
create function public.tests_acc(_traffic jsonb) returns text language sql as $$ select public.tests_hb(_traffic) ->> 'traffic_accepted' $$;
create function public.tests_backdate() returns void language sql security definer as $$ update public.web_hosting_state set last_seen_at = now() - interval '1 minute' $$;
create function public.tests_as(_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', _uid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
end $$;
create function public.tests_win(_offset int, _extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('ts', floor(extract(epoch from now()) / 300)::bigint * 300 - 150 + _offset, 'win', 55, 'lines', 100, 'bad', 0, 'trunc', 0, 'n', 100, 'b', 1000,
    's', jsonb_build_array(60, 0, 30, 10), 'm', 40, 'ua', jsonb_build_object('g', 0, 'b', 50, 'h', 50, 'e', 0),
    'd', jsonb_build_array(jsonb_build_object('h', 'shop.fr', 'n', 100, 'b', 1000, 's', jsonb_build_array(60, 0, 30, 10), 'm', 40, 'bt', 50)),
    'u', jsonb_build_array(jsonb_build_object('h', 'shop.fr', 'p', '/wp-login.php', 'n', 40, 'e', 5, 'm', 38)),
    'i', jsonb_build_array(jsonb_build_object('ip', '198.51.100.7', 'n', 60))) || _extra $$;

set local role anon;
-- Fenêtre complète (agent 0.4.0).
select is(public.tests_acc(jsonb_build_array(public.tests_win(0, jsonb_build_object(
  'q', jsonb_build_array(jsonb_build_object('h', 'shop.fr', 'q', 'filter_couleur,min_price,orderby', 'n', 30, 'e', 3)),
  'a', jsonb_build_array(jsonb_build_object('ua', 'Mozilla/5.0 (compatible; AhrefsBot/7.0)', 'n', 50)),
  'x', jsonb_build_array(jsonb_build_object('ip', '198.51.100.7', 'h', 'shop.fr', 'n', 60)),
  'dm', jsonb_build_array(jsonb_build_object('h', 'shop.fr', 'pc', 12, 'n4', 25, 'n3', 5)))))), '1', 'fenêtre 0.4.0 acceptée');
reset role;
select is((select queries -> 0 ->> 'q' from public.traffic_detail), 'filter_couleur,min_price,orderby', 'motif de paramètres conservé');
select is((select jsonb_array_length(uas) from public.traffic_detail), 1, 'user-agents conservés');
select is((select ipdomains -> 0 ->> 'h' from public.traffic_detail), 'shop.fr', 'IP × domaine conservés');
select is((select (domdetail -> 0 ->> 'n4')::int from public.traffic_detail), 25, '404 par domaine conservés');
select is((select (paths -> 0 ->> 'm')::int from public.traffic_detail), 38, 'POST par URL conservés');

-- Assainissement : caractères dangereux neutralisés, tailles bornées.
select public.tests_backdate();
set local role anon;
select public.tests_acc(jsonb_build_array(public.tests_win(10, jsonb_build_object(
  'q', jsonb_build_array(jsonb_build_object('h', 'shop.fr', 'q', 'a"b;drop', 'n', 5)),
  'a', jsonb_build_array(jsonb_build_object('ua', 'Evil"UA<script>' || repeat('x', 200), 'n', 5))))));
reset role;
select is((select queries -> 0 ->> 'q' from public.traffic_detail order by ts desc limit 1), 'a_b_drop', 'motif : caractères dangereux remplacés');
select ok((select length(uas -> 0 ->> 'ua') <= 70 and (uas -> 0 ->> 'ua') !~ '["<>]' from public.traffic_detail order by ts desc limit 1), 'user-agent : borné et sans guillemet ni chevron');

-- Un agent plus ancien (sans les nouveaux champs) reste accepté, colonnes vides.
select public.tests_backdate();
set local role anon;
select is(public.tests_acc(jsonb_build_array(public.tests_win(20))), '1', 'fenêtre d''un agent 0.3.x acceptée');
reset role;
select is((select queries from public.traffic_detail order by ts desc limit 1), '[]'::jsonb, 'agent ancien : colonnes vides');

-- Lectures.
set local role authenticated;
select public.tests_as('00000000-0000-0000-0000-00000000000a');
select is((public.get_hosting_traffic('00000000-0000-0000-0000-0000000000a1', 60) #>> '{queries,0,query}'), 'filter_couleur,min_price,orderby', 'lecture : motifs');
select is((public.get_hosting_traffic('00000000-0000-0000-0000-0000000000a1', 60) #>> '{queries,0,requests}')::int, 30, 'lecture : requêtes du motif');
select ok(jsonb_array_length(public.get_hosting_traffic('00000000-0000-0000-0000-0000000000a1', 60) -> 'uas') >= 1, 'lecture : user-agents');
select is((public.get_hosting_traffic('00000000-0000-0000-0000-0000000000a1', 60) #>> '{ipdomains,0,ip}'), '198.51.100.7', 'lecture : IP × domaine');
select is((public.get_hosting_traffic('00000000-0000-0000-0000-0000000000a1', 60) #>> '{domdetail,0,not_found}')::int, 25, 'lecture : 404 par domaine');
select ok((public.get_hosting_traffic('00000000-0000-0000-0000-0000000000a1', 60) #>> '{paths,0,posts}')::int >= 38, 'lecture : POST par URL');
reset role;

-- Trafic d'incident (Cloud entier) : mêmes agrégats.
insert into public.traffic_5m (web_hosting_id, workspace_id, ts, domain, requests, bytes, r4xx, r5xx, posts)
select '00000000-0000-0000-0000-0000000000a1', id, now() - interval '3 minutes', 'shop.fr', 100, 10, 30, 10, 40 from public.workspaces;
select is((public.compute_incident_traffic('00000000-0000-0000-0000-0000000000c1', now() - interval '20 minutes', now()) #>> '{queries,0,query}'), 'filter_couleur,min_price,orderby', 'incident : motifs');
select is((public.compute_incident_traffic('00000000-0000-0000-0000-0000000000c1', now() - interval '20 minutes', now()) #>> '{totals,r5xx}')::int, 40, 'incident : totaux par famille de codes (3 fenêtres + 1 ligne)');
select ok(jsonb_array_length(public.compute_incident_traffic('00000000-0000-0000-0000-0000000000c1', now() - interval '20 minutes', now()) -> 'ips') >= 1, 'incident : IP');

select * from finish();
rollback;
