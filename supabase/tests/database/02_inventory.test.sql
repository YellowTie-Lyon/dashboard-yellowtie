-- Tests pgTAP : inventaire (Clouds, hébergements, sites), tokens, collecteur, import, audit.
begin;
select plan(47);

-- Comptes : A = propriétaire (1er utilisateur), B = étranger, C = lecteur, D = propriétaire d'un autre workspace.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.test'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.test'),
  ('00000000-0000-0000-0000-00000000000c', 'c@example.test'),
  ('00000000-0000-0000-0000-00000000000d', 'd@example.test');

insert into public.workspace_members (workspace_id, user_id, role)
select id, '00000000-0000-0000-0000-00000000000c', 'viewer' from public.workspaces;

insert into public.workspaces (id, name) values ('00000000-0000-0000-0000-0000000000f2', 'Autre');
insert into public.workspace_members (workspace_id, user_id, role)
values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-00000000000d', 'owner');
insert into public.cloud_servers (id, workspace_id, name, slug)
values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f2', 'Cloud autre', 'autre');

-- Aides de test
create function public.tests_as(_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', _uid::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
end $$;
create table public.tests_tokens (label text, token text);
grant all on public.tests_tokens to authenticated;

-- ============================ A : propriétaire ===================================================
set local role authenticated;
select public.tests_as('00000000-0000-0000-0000-00000000000a');

select lives_ok(
  $$insert into public.cloud_servers (workspace_id, name, slug, cpu_cores)
    select id, 'Cloud 1', 'cloud-1', 12 from public.workspaces$$,
  'le propriétaire crée un Server Cloud');
select is((select count(*)::int from public.cloud_servers), 1,
  'le propriétaire ne voit que les Clouds de son workspace');
select throws_ok(
  $$insert into public.cloud_servers (workspace_id, name, slug)
    select id, 'Doublon', 'cloud-1' from public.workspaces$$,
  '23505', null, 'slug unique par workspace');
select throws_ok(
  $$insert into public.cloud_servers (workspace_id, name, slug)
    select id, 'Mauvais', 'Mauvais Slug' from public.workspaces$$,
  '23514', null, 'format de slug contrôlé');
select throws_ok(
  $$insert into public.cloud_servers (workspace_id, name, slug, provider)
    select id, 'X', 'x', 'autre' from public.workspaces$$,
  '42501', null, 'la colonne provider n''est pas écrivable par le client');
select throws_ok(
  $$insert into public.cloud_servers (workspace_id, name, slug)
    values ('00000000-0000-0000-0000-0000000000f2', 'Intrus', 'intrus')$$,
  '42501', null, 'impossible de créer un Cloud dans un autre workspace');

select lives_ok(
  $$insert into public.web_hostings (cloud_server_id, name, probe_url)
    select id, 'H1', 'https://exemple.fr/ik-probe.txt' from public.cloud_servers where slug = 'cloud-1'$$,
  'création du 1er hébergement (sans workspace_id)');
select lives_ok(
  $$insert into public.web_hostings (cloud_server_id, name)
    select id, 'H2' from public.cloud_servers where slug = 'cloud-1'$$,
  'création du 2e hébergement');
select is((select system_metrics_collector from public.web_hostings where name = 'H1'), true,
  'le 1er hébergement devient collecteur automatiquement');
select is((select system_metrics_collector from public.web_hostings where name = 'H2'), false,
  'le 2e hébergement n''est pas collecteur');
select is(
  (select workspace_id from public.web_hostings where name = 'H1'),
  (select workspace_id from public.cloud_servers where slug = 'cloud-1'),
  'workspace_id dérivé du Server Cloud parent');
select throws_ok(
  $$insert into public.web_hostings (cloud_server_id, name)
    values ('00000000-0000-0000-0000-0000000000c2', 'Intrus')$$,
  '42501', null, 'impossible de créer un hébergement sur le Cloud d''un autre workspace');
select throws_ok(
  $$insert into public.web_hostings (cloud_server_id, name, probe_url)
    select id, 'H3', 'http://non-https.fr' from public.cloud_servers where slug = 'cloud-1'$$,
  '23514', null, 'la sonde doit être en HTTPS');
select throws_ok(
  $$update public.web_hostings set system_metrics_collector = true where name = 'H2'$$,
  '42501', null, 'le collecteur ne se modifie pas directement');
select throws_ok(
  $$update public.web_hostings set token_active = true where name = 'H2'$$,
  '42501', null, 'l''état du token ne se modifie pas directement');
select throws_ok(
  $$update public.web_hostings
       set cloud_server_id = '00000000-0000-0000-0000-0000000000c2' where name = 'H2'$$,
  '42501', null, 'un hébergement ne change pas de Cloud');

-- Collecteur
select lives_ok($$select public.set_system_collector((select id from public.web_hostings where name = 'H2'))$$,
  'désignation du collecteur');
select is((select system_metrics_collector from public.web_hostings where name = 'H2'), true,
  'H2 est maintenant collecteur');
select is((select system_metrics_collector from public.web_hostings where name = 'H1'), false,
  'H1 ne l''est plus (un seul collecteur par Cloud)');

-- Tokens
insert into public.tests_tokens
select 'first', public.rotate_hosting_token((select id from public.web_hostings where name = 'H1'));
select matches((select token from public.tests_tokens where label = 'first'),
  '^ikh_[0-9a-f]{12}_[0-9a-f]{64}$', 'format du token');
select is((select token_active from public.web_hostings where name = 'H1'), true, 'token actif');
select is((select token_public_id from public.web_hostings where name = 'H1'),
  (select split_part(token, '_', 2) from public.tests_tokens where label = 'first'),
  'l''identifiant public correspond au token');
select throws_ok($$select token_hash from public.web_hosting_credentials$$, '42501', null,
  'le client ne lit jamais les credentials');

insert into public.tests_tokens
select 'second', public.rotate_hosting_token((select id from public.web_hostings where name = 'H1'));
insert into public.tests_tokens
select 'third', public.rotate_hosting_token((select id from public.web_hostings where name = 'H1'), 0);

-- ============================ Contrôle des secrets (superutilisateur) ============================
reset role;
select is(
  (select token_hash from public.web_hosting_credentials
    where web_hosting_id = (select id from public.web_hostings where name = 'H1')),
  sha256(convert_to((select split_part(token, '_', 3) from public.tests_tokens where label = 'third'), 'UTF8')),
  'seul le SHA-256 du secret est stocké');
select is(
  (select prev_token_hash from public.web_hosting_credentials
    where web_hosting_id = (select id from public.web_hostings where name = 'H1')),
  null,
  'rotation sans période de grâce : aucun ancien hash conservé');
select is(
  (select split_part(token, '_', 2) from public.tests_tokens where label = 'second'),
  (select split_part(token, '_', 2) from public.tests_tokens where label = 'third'),
  'l''identifiant public reste stable entre rotations');
select isnt(
  (select split_part(token, '_', 3) from public.tests_tokens where label = 'first'),
  (select split_part(token, '_', 3) from public.tests_tokens where label = 'second'),
  'chaque rotation produit un nouveau secret');
select throws_ok(
  $$update public.web_hostings set system_metrics_collector = true where name = 'H1'$$,
  '23505', null, 'l''index unique interdit deux collecteurs sur un Cloud');

-- Période de grâce : nouvelle rotation avec grâce sur H2
select public.tests_as('00000000-0000-0000-0000-00000000000a');
set local role authenticated;
select public.rotate_hosting_token((select id from public.web_hostings where name = 'H2'));
select public.rotate_hosting_token((select id from public.web_hostings where name = 'H2'), 60);
reset role;
select ok(
  (select prev_token_hash is not null and prev_token_expires_at > now() + interval '59 minutes'
          and prev_token_expires_at < now() + interval '61 minutes'
     from public.web_hosting_credentials
    where web_hosting_id = (select id from public.web_hostings where name = 'H2')),
  'rotation avec grâce : l''ancien hash reste valide 60 minutes');

-- Révocation
set local role authenticated;
select public.tests_as('00000000-0000-0000-0000-00000000000a');
select lives_ok($$select public.revoke_hosting_token((select id from public.web_hostings where name = 'H1'))$$,
  'révocation du token');
select is((select token_active from public.web_hostings where name = 'H1'), false, 'token inactif après révocation');
reset role;
select is(
  (select token_hash is null and prev_token_hash is null from public.web_hosting_credentials
    where web_hosting_id = (select id from public.web_hostings where name = 'H1')),
  true, 'hash supprimés après révocation');

-- Import de sites
set local role authenticated;
select public.tests_as('00000000-0000-0000-0000-00000000000a');
select is(
  (select public.import_sites((select id from public.web_hostings where name = 'H1'),
     array['  HTTPS://www.Example.fr/chemin?x=1 ', 'exemple.com:8080', 'mauvais_domaine', 'exemple.com', '', 'localhost'])),
  '{"inserted": 2, "existing": 0, "invalid": ["mauvais_domaine", "localhost"]}'::jsonb,
  'import normalisé : 2 insérés, doublon ignoré, 2 invalides');
select is(
  (select public.import_sites((select id from public.web_hostings where name = 'H1'), array['www.example.fr'])),
  '{"inserted": 0, "existing": 1, "invalid": []}'::jsonb,
  'réimport : domaine déjà présent');
select is((select count(*)::int from public.sites), 2, 'deux sites enregistrés');
select throws_ok(
  $$insert into public.sites (workspace_id, web_hosting_id, domain)
    select workspace_id, id, 'direct.fr' from public.web_hostings where name = 'H1'$$,
  '42501', null, 'insertion directe de sites interdite (import uniquement)');
select throws_ok($$update public.sites set domain = 'autre.fr'$$, '42501', null,
  'le domaine d''un site n''est pas modifiable');
select lives_ok($$update public.sites set is_active = false where domain = 'exemple.com'$$,
  'un site peut être désactivé');

-- Audit
select is((select count(*)::int from public.audit_log where action = 'hosting.token_rotated'), 5,
  'les rotations sont journalisées');

-- ============================ C : lecteur ========================================================
select public.tests_as('00000000-0000-0000-0000-00000000000c');
select is((select count(*)::int from public.cloud_servers), 1, 'le lecteur voit les Clouds');
select throws_ok(
  $$insert into public.cloud_servers (workspace_id, name, slug)
    select id, 'Lecteur', 'lecteur' from public.workspaces$$,
  '42501', null, 'le lecteur ne crée rien');
select throws_ok($$select public.rotate_hosting_token((select id from public.web_hostings where name = 'H1'))$$,
  '42501', 'forbidden', 'le lecteur ne régénère pas de token');
select is((select count(*)::int from public.audit_log), 0, 'le lecteur ne voit pas le journal d''audit');

-- ============================ B : étranger =======================================================
select public.tests_as('00000000-0000-0000-0000-00000000000b');
select is((select count(*)::int from public.cloud_servers) + (select count(*)::int from public.web_hostings)
        + (select count(*)::int from public.sites), 0, 'un étranger ne voit aucun inventaire');
select throws_ok($$select public.import_sites((select id from public.web_hostings where name = 'H1'), array['x.fr'])$$,
  '42501', null, 'un étranger ne peut pas importer de sites');

-- ============================ Anonyme ============================================================
reset role;
set local role anon;
select throws_ok($$select * from public.cloud_servers$$, '42501', null, 'anonyme : aucune lecture');
select throws_ok($$select public.rotate_hosting_token('00000000-0000-0000-0000-000000000001')$$, '42501', null,
  'anonyme : aucune exécution des RPC');

select * from finish();
rollback;
