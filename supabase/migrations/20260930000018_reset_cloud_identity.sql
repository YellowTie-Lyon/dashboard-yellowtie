-- Migration vers un nouveau serveur : le Cloud « oublie » son hostname et son nombre de cœurs, que le premier relevé du nouveau
-- serveur renseignera de nouveau (sinon : anomalie hostname_mismatch et load par cœur calculé avec l'ancien nombre de cœurs).
-- L'historique, les incidents, les seuils, les hébergements et les tokens sont conservés.
create function public.reset_cloud_identity(_cloud_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _c public.cloud_servers;
begin
  select * into _c from public.cloud_servers where id = _cloud_id;
  if not found or not public.has_workspace_role(_c.workspace_id, array['owner']::public.workspace_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.cloud_servers set hostname = null, cpu_cores = null where id = _cloud_id;
  update public.web_hosting_state set anomaly = null
   where anomaly = 'hostname_mismatch'
     and web_hosting_id in (select id from public.web_hostings where cloud_server_id = _cloud_id);

  perform public.write_audit(_c.workspace_id, 'cloud.identity_reset', 'cloud_servers', _cloud_id);
end;
$$;
revoke all on function public.reset_cloud_identity(uuid) from public, anon;
grant execute on function public.reset_cloud_identity(uuid) to authenticated;
