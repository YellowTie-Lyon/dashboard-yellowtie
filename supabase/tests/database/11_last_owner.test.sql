-- Tests pgTAP : le dernier propriétaire est protégé contre la suppression (directe ou en cascade depuis auth.users).
begin;
select plan(6);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@example.test'),   -- 1er utilisateur : propriétaire
  ('00000000-0000-0000-0000-00000000000b', 'lecteur@example.test'),
  ('00000000-0000-0000-0000-00000000000c', 'second@example.test');
insert into public.workspace_members (workspace_id, user_id, role)
select id, '00000000-0000-0000-0000-00000000000b', 'viewer' from public.workspaces;

select throws_ok($$delete from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000a'$$, '23514', null,
  'le dernier propriétaire ne peut pas être retiré');
select throws_ok($$delete from auth.users where id = '00000000-0000-0000-0000-00000000000a'$$, '23514', null,
  'supprimer son compte (cascade) est refusé aussi');
select lives_ok($$delete from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000b'$$, 'un lecteur peut être retiré');

insert into public.workspace_members (workspace_id, user_id, role)
select id, '00000000-0000-0000-0000-00000000000c', 'owner' from public.workspaces;
select lives_ok($$delete from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000a'$$,
  'avec un autre propriétaire, le retrait est possible');
select throws_ok($$delete from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000c'$$, '23514', null,
  'le nouveau dernier propriétaire est protégé à son tour');
select lives_ok($$delete from public.workspaces$$, 'supprimer un workspace entier reste possible');

select * from finish();
rollback;
