-- Tests pgTAP : double authentification obligatoire (aal2), gestion des membres, journal d'audit.
begin;
select plan(28);

insert into auth.users (id, email, last_sign_in_at) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@example.test', now()),    -- propriétaire (1er utilisateur)
  ('00000000-0000-0000-0000-00000000000b', 'lecteur@example.test', null),   -- lecteur
  ('00000000-0000-0000-0000-00000000000c', 'etranger@example.test', null);  -- sans workspace
insert into public.workspace_members (workspace_id, user_id, role)
select id, '00000000-0000-0000-0000-00000000000b', 'viewer' from public.workspaces;
insert into public.cloud_servers (id, workspace_id, name, slug)
select '00000000-0000-0000-0000-0000000000c1', id, 'Cloud 1', 'cloud-1' from public.workspaces;
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values
  (gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', 'test-a', 'totp', 'verified', now(), now()),
  (gen_random_uuid(), '00000000-0000-0000-0000-00000000000b', 'test-b', 'totp', 'unverified', now(), now());   -- inscription abandonnée : ne compte pas

create function public.tests_as(_uid uuid, _aal text default 'aal2') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', _uid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', _uid, 'role', 'authenticated', 'aal', _aal)::text, true);
end $$;

-- ============================ aal1 : mot de passe seul ==========================================
set local role authenticated;
select public.tests_as('00000000-0000-0000-0000-00000000000a', 'aal1');
select is(public.is_aal2(), false, 'session aal1 : pas de double facteur validé');
select is((select count(*)::int from public.cloud_servers), 0, 'aal1 : aucune donnée lisible malgré un mot de passe valide');
select is((select count(*)::int from public.workspaces), 0, 'aal1 : le workspace est invisible');
select is(public.get_storage_stats(), null, 'aal1 : pas de statistiques');
select throws_ok($$select * from public.list_workspace_members()$$, '42501', 'forbidden', 'aal1 : liste des membres refusée');
select throws_ok($$select public.set_member_role('00000000-0000-0000-0000-00000000000b', 'owner')$$, '42501', 'forbidden', 'aal1 : changement de rôle refusé');
select public.tests_as('00000000-0000-0000-0000-00000000000a', 'aal2');
select public.tests_as('00000000-0000-0000-0000-00000000000a', null);
select is(public.is_aal2(), false, 'claim aal absent : refusé');

-- ============================ aal2 : double facteur validé ======================================
select public.tests_as('00000000-0000-0000-0000-00000000000a', 'aal2');
select is(public.is_aal2(), true, 'session aal2 reconnue');
select is((select count(*)::int from public.cloud_servers), 1, 'aal2 : les données sont lisibles');
select isnt(public.get_storage_stats(), null, 'aal2 : statistiques disponibles');

select is((select count(*)::int from public.list_workspace_members()), 2, 'le propriétaire liste les 2 membres');
select is((select email from public.list_workspace_members() where is_self), 'owner@example.test', 'le propriétaire se reconnaît (is_self)');
select is((select mfa_enabled from public.list_workspace_members() where email = 'owner@example.test'), true, 'double facteur actif détecté');
select is((select mfa_enabled from public.list_workspace_members() where email = 'lecteur@example.test'), false, 'un facteur non validé ne compte pas');
select is((select role from public.list_workspace_members() where email = 'lecteur@example.test')::text, 'viewer', 'rôle affiché');

-- ============================ Rôles ==========================================================
select lives_ok($$select public.set_member_role('00000000-0000-0000-0000-00000000000b', 'owner')$$, 'promotion d''un lecteur en propriétaire');
select is((select role from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000b')::text, 'owner', 'rôle mis à jour');
select lives_ok($$select public.set_member_role('00000000-0000-0000-0000-00000000000b', 'viewer')$$, 'rétrogradation possible tant qu''il reste un propriétaire');
select throws_ok($$select public.set_member_role('00000000-0000-0000-0000-00000000000a', 'viewer')$$, '23514', 'last owner',
  'le dernier propriétaire ne peut pas être rétrogradé');
select throws_ok($$select public.set_member_role('00000000-0000-0000-0000-00000000000c', 'viewer')$$, 'P0002', 'unknown member',
  'on ne modifie pas un utilisateur hors workspace');
select is((select count(*)::int from public.audit_log where action = 'member.role_changed'), 2, 'chaque changement de rôle est journalisé');

-- ============================ Lecteur et étranger ================================================
select public.tests_as('00000000-0000-0000-0000-00000000000b', 'aal2');
select is((select count(*)::int from public.cloud_servers), 1, 'un lecteur aal2 lit les données');
select throws_ok($$select * from public.list_workspace_members()$$, '42501', 'forbidden', 'un lecteur ne liste pas les membres');
select throws_ok($$select public.set_member_role('00000000-0000-0000-0000-00000000000b', 'owner')$$, '42501', 'forbidden', 'un lecteur ne peut pas se promouvoir');
select public.tests_as('00000000-0000-0000-0000-00000000000c', 'aal2');
select is((select count(*)::int from public.cloud_servers), 0, 'un utilisateur sans workspace ne voit rien, même en aal2');

-- ============================ Journal des actions de la fonction Edge =========================
reset role;
grant usage on schema public to service_role;
create table public.tests_ws as select id from public.workspaces;
grant select on public.tests_ws to service_role, authenticated;
set local role authenticated;
select throws_ok($$select public.record_user_event((select id from public.tests_ws limit 1), null, 'user.invited', null)$$, '42501', null,
  'record_user_event est fermée aux utilisateurs');
reset role;
set local role service_role;
select lives_ok($$select public.record_user_event((select id from public.tests_ws limit 1), '00000000-0000-0000-0000-00000000000a', 'user.invited', '00000000-0000-0000-0000-00000000000b', '{"email":"x"}')$$,
  'la clé de service peut journaliser');
reset role;
select is((select count(*)::int from public.audit_log where action = 'user.invited'), 1, 'événement enregistré');

select * from finish();
rollback;
