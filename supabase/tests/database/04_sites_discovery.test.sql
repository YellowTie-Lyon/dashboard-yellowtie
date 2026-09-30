-- Tests pgTAP : découverte automatique des sites (noms des dossiers de ~/sites remontés par l'agent).
begin;
select plan(23);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'a@example.test');
insert into public.cloud_servers (id, workspace_id, name, slug)
select '00000000-0000-0000-0000-0000000000c1', id, 'Cloud 1', 'cloud-1' from public.workspaces;
insert into public.web_hostings (id, cloud_server_id, name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'H1'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1', 'H2');
insert into public.web_hosting_credentials (web_hosting_id, token_hash)
values ('00000000-0000-0000-0000-0000000000a1', sha256(convert_to(repeat('a', 64), 'UTF8'))),
       ('00000000-0000-0000-0000-0000000000a2', sha256(convert_to(repeat('b', 64), 'UTF8')));
update public.web_hostings set token_public_id = repeat('a', 12), token_active = true where name = 'H1';
update public.web_hostings set token_public_id = repeat('b', 12), token_active = true where name = 'H2';

create function public.tests_hb(_n int, _domains jsonb) returns jsonb language plpgsql as $$
begin
  perform set_config('request.headers', jsonb_build_object('x-agent-token',
    'ikh_' || repeat(substr('ab', _n, 1), 12) || '_' || repeat(substr('ab', _n, 1), 64))::text, true);
  return public.agent_heartbeat(jsonb_build_object('v', 1, 'agent_version', '0.2.0', 'hostname', 'od-x',
    'points', '[]'::jsonb) || case when _domains is null then '{}'::jsonb else jsonb_build_object('domains', _domains) end);
end $$;
create function public.tests_backdate() returns void language sql security definer as
$$ update public.web_hosting_state set last_seen_at = now() - interval '1 minute' $$;

-- Un site saisi à la main avant la découverte
insert into public.sites (workspace_id, web_hosting_id, domain, source)
select workspace_id, id, 'manuel.fr', 'manual' from public.web_hostings where name = 'H2';

set local role anon;
select lives_ok($$select public.tests_hb(2, '["Exemple.FR ", "blog.exemple.fr", "192.168.1.10", "localhost",
  "a_b.fr", "exemple.fr", "xn--nxasmq6b.com", "manuel.fr", 123, null, {"x": 1}, "", "-x.fr", "trop..long.fr"]'::jsonb)$$,
  'heartbeat avec une liste de domaines mêlant valides et invalides');
reset role;

select is((select array_agg(domain order by domain) from public.sites
           where web_hosting_id = '00000000-0000-0000-0000-0000000000a2'),
          array['blog.exemple.fr', 'exemple.fr', 'manuel.fr', 'xn--nxasmq6b.com'],
          'seuls les domaines valides sont créés (minuscules, doublons fusionnés, IP et bruit écartés)');
select is((select count(*)::int from public.sites where domain = 'exemple.fr' and source = 'discovered'
             and is_verified and is_active), 1, 'un site découvert est créé actif et vérifié');
select is((select source from public.sites where domain = 'manuel.fr'), 'manual',
          'un site saisi à la main garde son origine');
select isnt((select last_seen_at from public.sites where domain = 'manuel.fr'), null,
            'un site existant voit sa date de dernière observation renseignée');
select is((select count(*)::int from public.sites where web_hosting_id = '00000000-0000-0000-0000-0000000000a1'), 0,
          'les domaines de H2 ne sont jamais attribués à H1 (identité issue du token)');

-- Nouvelle observation : first_seen inchangé, last_seen mis à jour
update public.sites set first_seen_at = now() - interval '2 days', last_seen_at = now() - interval '2 days'
 where domain = 'exemple.fr';
select public.tests_backdate();
set local role anon;
select lives_ok($$select public.tests_hb(2, '["exemple.fr"]'::jsonb)$$, 'nouvelle observation acceptée');
reset role;
select ok((select last_seen_at > now() - interval '1 minute' from public.sites where domain = 'exemple.fr'),
          'last_seen_at rafraîchi');
select ok((select first_seen_at < now() - interval '1 day' from public.sites where domain = 'exemple.fr'),
          'first_seen_at conservé');
select is((select count(*)::int from public.sites where web_hosting_id = '00000000-0000-0000-0000-0000000000a2'), 4,
          'un domaine absent d''une observation n''est jamais supprimé');

-- Entrées non conformes : ignorées sans erreur
select public.tests_backdate();
set local role anon;
select lives_ok($$select public.tests_hb(2, '{"pas": "un tableau"}'::jsonb)$$, 'domains non tableau : ignoré');
select public.tests_backdate();
select lives_ok($$select public.tests_hb(2, '"exemple.fr"'::jsonb)$$, 'domains chaîne : ignoré');
reset role;
select is((select count(*)::int from public.sites where web_hosting_id = '00000000-0000-0000-0000-0000000000a2'), 4,
          'rien de créé par des entrées non conformes');

-- Même domaine sur deux hébergements : autorisé (unicité par hébergement)
select public.tests_backdate();
set local role anon;
select lives_ok($$select public.tests_hb(1, '["exemple.fr", "propre-a-h1.fr"]'::jsonb)$$, 'H1 déclare ses domaines');
reset role;
select is((select count(*)::int from public.sites where domain = 'exemple.fr'), 2, 'un même domaine peut exister sur deux hébergements');

-- Plafond de 200 domaines par déclaration
select public.tests_backdate();
set local role anon;
select lives_ok($$select public.tests_hb(2, (select jsonb_agg('site' || i || '.fr') from generate_series(1, 250) i))$$,
  '250 domaines déclarés');
reset role;
select is((select count(*)::int from public.sites where domain like 'site%.fr'), 200,
          'au plus 200 domaines traités par déclaration');

-- Plafond de 500 sites par hébergement : plus de création au-delà
insert into public.sites (workspace_id, web_hosting_id, domain, source)
select workspace_id, id, 'plein' || i || '.fr', 'manual'
from public.web_hostings, generate_series(1, 500) i where name = 'H1';
select public.tests_backdate();
set local role anon;
select lives_ok($$select public.tests_hb(1, '["nouveau-domaine.fr"]'::jsonb)$$, 'hébergement plein : heartbeat accepté');
reset role;
select is((select count(*)::int from public.sites where domain = 'nouveau-domaine.fr'), 0,
          'au-delà de 500 sites par hébergement, plus de création automatique');

-- Contrainte d'origine et RLS
select lives_ok($$insert into public.sites (workspace_id, web_hosting_id, domain, source, is_verified)
  select workspace_id, id, 'vu-dans-les-logs.fr', 'log', false from public.web_hostings where name = 'H2'$$,
  'l''origine « log » est acceptée (phase 7)');
select throws_ok($$insert into public.sites (workspace_id, web_hosting_id, domain, source)
  select workspace_id, id, 'x.fr', 'inconnue' from public.web_hostings where name = 'H2'$$,
  '23514', null, 'une origine inconnue est refusée');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select ok((select count(*) from public.sites where source = 'discovered') > 0, 'le propriétaire voit les sites découverts');
select lives_ok($$update public.sites set is_active = false where domain = 'blog.exemple.fr'$$,
  'le propriétaire peut désactiver un site découvert');

select * from finish();
rollback;
