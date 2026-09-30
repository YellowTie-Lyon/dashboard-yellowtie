-- Garde-fou : le dernier propriétaire d'un workspace ne peut pas être retiré (ni directement, ni en supprimant son compte
-- dans Supabase > Authentication > Users, qui supprime en cascade son appartenance). Sans propriétaire, plus personne ne
-- pourrait gérer le workspace. Il faut d'abord promouvoir un autre propriétaire (menu Utilisateurs).
-- La suppression d'un workspace entier reste possible (la ligne du workspace n'existe déjà plus quand la cascade arrive ici).
create function public.protect_last_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.role = 'owner'
     and exists (select 1 from public.workspaces w where w.id = old.workspace_id)
     and not exists (
       select 1 from public.workspace_members m
        where m.workspace_id = old.workspace_id and m.role = 'owner' and m.user_id <> old.user_id
     ) then
    raise exception 'last owner: promouvez d''abord un autre propriétaire avant de retirer celui-ci' using errcode = '23514';
  end if;
  return old;
end;
$$;

create trigger workspace_members_protect_last_owner
  before delete on public.workspace_members
  for each row execute function public.protect_last_owner();
