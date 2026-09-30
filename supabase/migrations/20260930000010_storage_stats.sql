-- Phase 8 : suivi du stockage (quota Supabase) — taille de la base et des plus grosses tables.
--
-- Lecture seule, réservée aux membres d'un workspace. Ne renvoie que des tailles et des ordres de grandeur de lignes,
-- pour les tables de l'application (schéma public) : aucune donnée métier.

create function public.get_storage_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (select 1 from public.workspace_members where user_id = auth.uid()) then
    return null;
  end if;
  return jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'tables', coalesce((
      select jsonb_agg(t order by (t ->> 'bytes')::bigint desc) from (
        select jsonb_build_object('name', c.relname, 'bytes', pg_total_relation_size(c.oid), 'rows', greatest(c.reltuples, 0)::bigint) t
          from pg_class c
         where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
         order by pg_total_relation_size(c.oid) desc
         limit 10
      ) q), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.get_storage_stats() from public, anon;
grant execute on function public.get_storage_stats() to authenticated;
