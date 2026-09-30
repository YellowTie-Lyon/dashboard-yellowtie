-- Tests pgTAP (exécutés par `supabase test db`).
begin;
select plan(11);

-- Utilisateurs de test : le premier reçoit le workspace, le second n'a aucune appartenance.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.test'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.test');

select is(
  (select count(*)::int from public.workspaces),
  1,
  'le premier utilisateur crée le workspace'
);
select is(
  (select role::text from public.workspace_members
    where user_id = '00000000-0000-0000-0000-00000000000a'),
  'owner',
  'le premier utilisateur en est propriétaire'
);
select is(
  (select count(*)::int from public.workspace_members
    where user_id = '00000000-0000-0000-0000-00000000000b'),
  0,
  'le second utilisateur n''est pas rattaché automatiquement'
);

-- ----- Membre : voit son workspace ------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}', true);

select is((select count(*)::int from public.workspaces), 1, 'un membre voit son workspace');
select is((select count(*)::int from public.workspace_members), 1, 'un membre voit les appartenances de son workspace');

select throws_ok(
  $$insert into public.workspaces (name) values ('pirate')$$,
  '42501', null,
  'un membre ne peut pas créer de workspace'
);
select throws_ok(
  $$insert into public.workspace_members (workspace_id, user_id, role)
    select id, '00000000-0000-0000-0000-00000000000b', 'owner' from public.workspaces$$,
  '42501', null,
  'un membre ne peut pas ajouter d''appartenance depuis le client'
);

-- ----- Non membre : ne voit rien --------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","aal":"aal2"}', true);

select is((select count(*)::int from public.workspaces), 0, 'un non-membre ne voit aucun workspace');
select is((select count(*)::int from public.workspace_members), 0, 'un non-membre ne voit aucune appartenance');

-- ----- Anonyme : aucun accès ------------------------------------------------------------------
reset role;
set local role anon;
select throws_ok(
  $$select * from public.workspaces$$,
  '42501', null,
  'l''anonyme n''a aucun accès à workspaces'
);
select throws_ok(
  $$select * from public.workspace_members$$,
  '42501', null,
  'l''anonyme n''a aucun accès à workspace_members'
);

select * from finish();
rollback;
