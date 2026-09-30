-- Tests pgTAP : suivi du stockage (droits, forme de la réponse).
begin;
select plan(7);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.test'),   -- propriétaire (1er utilisateur)
  ('00000000-0000-0000-0000-00000000000b', 'b@example.test');   -- étranger
create function public.tests_as(_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', _uid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
end $$;
delete from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000b';

set local role anon;
select throws_ok($$select public.get_storage_stats()$$, '42501', null, 'un visiteur anonyme ne peut pas lire les tailles');

set local role authenticated;
select public.tests_as('00000000-0000-0000-0000-00000000000a');
select isnt(public.get_storage_stats(), null, 'un membre obtient les statistiques');
select ok((public.get_storage_stats() ->> 'db_bytes')::bigint > 0, 'taille de la base renvoyée');
select ok(jsonb_array_length(public.get_storage_stats() -> 'tables') between 1 and 10, 'au plus 10 tables listées');
select ok((select bool_and((t ->> 'bytes')::bigint <= (lag_bytes)) from (
    select t, lag((t ->> 'bytes')::bigint) over (order by ord) lag_bytes from jsonb_array_elements(public.get_storage_stats() -> 'tables') with ordinality x(t, ord)
  ) q where lag_bytes is not null),
  'tables triées de la plus grosse à la plus petite');
select is((select (t ->> 'bytes')::bigint >= 0 from jsonb_array_elements(public.get_storage_stats() -> 'tables') t limit 1), true,
  'tailles positives');

select public.tests_as('00000000-0000-0000-0000-00000000000b');
select is(public.get_storage_stats(), null, 'un utilisateur sans workspace n''obtient rien');

select * from finish();
rollback;
