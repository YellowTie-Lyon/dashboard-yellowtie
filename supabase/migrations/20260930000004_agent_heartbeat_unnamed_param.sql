-- Correctif : PostgREST ne transmet le corps JSON entier à une fonction que si celle-ci a UN SEUL paramètre
-- json/jsonb SANS NOM (sinon il cherche une fonction dont les paramètres portent le nom des clés du corps :
-- « PGRST202 Could not find the function public.agent_heartbeat(agent, agent_version, ...) »).
--
-- La logique reste dans la fonction existante, renommée en agent_heartbeat_impl et fermée aux clients ;
-- agent_heartbeat(jsonb) n'en est plus que la porte d'entrée exposée.

alter function public.agent_heartbeat(jsonb) rename to agent_heartbeat_impl;
revoke all on function public.agent_heartbeat_impl(jsonb) from public, anon, authenticated;

create function public.agent_heartbeat(jsonb)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.agent_heartbeat_impl($1);
$$;

revoke all on function public.agent_heartbeat(jsonb) from public;
grant execute on function public.agent_heartbeat(jsonb) to anon, authenticated;
