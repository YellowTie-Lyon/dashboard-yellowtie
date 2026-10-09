-- Tests pgTAP : réinitialisation du hostname et des cœurs d'un Cloud (migration vers un nouveau serveur).
begin;
select plan(5);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'a@example.test'), ('00000000-0000-0000-0000-00000000000c', 'c@example.test');
insert into public.workspace_members (workspace_id, user_id, role)
select id, '00000000-0000-0000-0000-00000000000c', 'viewer' from public.workspaces;
insert into public.cloud_servers (id, workspace_id, name, slug, hostname, cpu_cores)
select '00000000-0000-0000-0000-0000000000c1', id, 'Cloud 1', 'cloud-1', 'od-old', 8 from public.workspaces;

create function public.tests_as(_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', _uid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
end $$;

set local role authenticated;
select public.tests_as('00000000-0000-0000-0000-00000000000c');
select throws_ok($$select public.reset_cloud_identity('00000000-0000-0000-0000-0000000000c1')$$, '42501', null, 'un lecteur ne peut pas réinitialiser');
select public.tests_as('00000000-0000-0000-0000-00000000000a');
select lives_ok($$select public.reset_cloud_identity('00000000-0000-0000-0000-0000000000c1')$$, 'le propriétaire peut réinitialiser');
select is((select hostname from public.cloud_servers where slug = 'cloud-1'), null, 'hostname oublié');
select is((select cpu_cores from public.cloud_servers where slug = 'cloud-1'), null, 'cœurs oubliés');
select is((select count(*)::int from public.audit_log where action = 'cloud.identity_reset'), 1, 'action journalisée');

select * from finish();
rollback;
