-- Phase 4 : séries temporelles pour les graphiques, agrégation horaire et purge.
--
-- Stockage :
--   metrics     relevés d'1 minute, conservés 35 jours (~50 000 lignes / Cloud, quelques Mo)
--   metrics_1h  agrégats horaires (moyenne ET maximum : un pic ne disparaît pas dans une moyenne), 400 jours
-- Lecture : get_series() choisit la source et la finesse selon la période et renvoie au plus ~720 points,
-- si bien que le navigateur ne charge jamais des dizaines de milliers de lignes.

create table public.metrics_1h (
  cloud_server_id    uuid not null references public.cloud_servers (id) on delete cascade,
  ts                 timestamptz not null,               -- début de l'heure (alignée sur l'heure UTC)
  n                  integer not null check (n > 0),     -- nombre de relevés agrégés
  load1_avg          real not null, load1_max   real not null,
  load5_avg          real not null, load5_max   real not null,
  load15_avg         real not null, load15_max  real not null,
  cpu_pct_avg        real, cpu_pct_max          real,    -- nul si aucun CPU calculable sur l'heure
  mem_used_pct_avg   real not null, mem_used_pct_max  real not null,
  swap_used_pct_avg  real not null, swap_used_pct_max real not null,
  disk_used_pct_avg  real not null, disk_used_pct_max real not null,
  primary key (cloud_server_id, ts)
);

create index metrics_1h_ts_idx on public.metrics_1h (ts);   -- purge par ancienneté

-- Dernière exécution des tâches de maintenance (visible dans l'interface pour détecter un planificateur à l'arrêt).
create table public.job_state (
  name        text primary key,
  last_run_at timestamptz not null,
  detail      jsonb not null default '{}'::jsonb
);

alter table public.metrics_1h enable row level security;
alter table public.job_state enable row level security;
revoke all on public.metrics_1h from anon, authenticated;
revoke all on public.job_state from anon, authenticated;
grant select on public.metrics_1h to authenticated;
grant select on public.job_state to authenticated;

create policy metrics_1h_select on public.metrics_1h
  for select to authenticated
  using (exists (select 1 from public.cloud_servers c where c.id = metrics_1h.cloud_server_id));
create policy job_state_select on public.job_state
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Agrégation horaire (idempotente : recalcule les heures des dernières _since, relançable à volonté)
-- ---------------------------------------------------------------------------
create function public.rollup_metrics(_since interval default interval '3 hours')
returns integer
language plpgsql
set search_path = ''
as $$
declare
  _origin constant timestamptz := timestamptz '2000-01-01 00:00:00+00';
  _n integer;
begin
  insert into public.metrics_1h as h (
    cloud_server_id, ts, n,
    load1_avg, load1_max, load5_avg, load5_max, load15_avg, load15_max,
    cpu_pct_avg, cpu_pct_max, mem_used_pct_avg, mem_used_pct_max,
    swap_used_pct_avg, swap_used_pct_max, disk_used_pct_avg, disk_used_pct_max
  )
  select m.cloud_server_id, date_bin(interval '1 hour', m.ts, _origin), count(*)::integer,
         avg(m.load1), max(m.load1), avg(m.load5), max(m.load5), avg(m.load15), max(m.load15),
         avg(m.cpu_pct), max(m.cpu_pct), avg(m.mem_used_pct), max(m.mem_used_pct),
         avg(m.swap_used_pct), max(m.swap_used_pct), avg(m.disk_used_pct), max(m.disk_used_pct)
  from public.metrics m
  where m.ts >= date_bin(interval '1 hour', now() - _since, _origin)
  group by 1, 2
  on conflict (cloud_server_id, ts) do update set
    n = excluded.n,
    load1_avg = excluded.load1_avg, load1_max = excluded.load1_max,
    load5_avg = excluded.load5_avg, load5_max = excluded.load5_max,
    load15_avg = excluded.load15_avg, load15_max = excluded.load15_max,
    cpu_pct_avg = excluded.cpu_pct_avg, cpu_pct_max = excluded.cpu_pct_max,
    mem_used_pct_avg = excluded.mem_used_pct_avg, mem_used_pct_max = excluded.mem_used_pct_max,
    swap_used_pct_avg = excluded.swap_used_pct_avg, swap_used_pct_max = excluded.swap_used_pct_max,
    disk_used_pct_avg = excluded.disk_used_pct_avg, disk_used_pct_max = excluded.disk_used_pct_max;
  get diagnostics _n = row_count;

  insert into public.job_state (name, last_run_at, detail)
  values ('rollup', now(), jsonb_build_object('buckets', _n))
  on conflict (name) do update set last_run_at = excluded.last_run_at, detail = excluded.detail;
  return _n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Purge : relevés d'1 minute > 35 jours, agrégats horaires > 400 jours (durées modifiables par paramètre)
-- ---------------------------------------------------------------------------
create function public.purge_old_data(_raw_days integer default 35, _hourly_days integer default 400)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  _raw integer;
  _hourly integer;
begin
  if _raw_days < 8 or _hourly_days < 35 then
    raise exception 'retention too short' using errcode = '22023';   -- garde-fou : ne jamais purger sous 7 j / 30 j
  end if;
  delete from public.metrics where ts < now() - make_interval(days => _raw_days);
  get diagnostics _raw = row_count;
  delete from public.metrics_1h where ts < now() - make_interval(days => _hourly_days);
  get diagnostics _hourly = row_count;

  insert into public.job_state (name, last_run_at, detail)
  values ('purge', now(), jsonb_build_object('raw_deleted', _raw, 'hourly_deleted', _hourly))
  on conflict (name) do update set last_run_at = excluded.last_run_at, detail = excluded.detail;
  return jsonb_build_object('raw_deleted', _raw, 'hourly_deleted', _hourly);
end;
$$;

revoke all on function public.rollup_metrics(interval) from public, anon, authenticated;
revoke all on function public.purge_old_data(integer, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- get_series : la seule lecture utilisée par les graphiques (SECURITY INVOKER : la RLS s'applique)
--   1h, 6h   relevés d'1 minute                     (60 / 360 points)
--   24h      tranches de 5 minutes, depuis les relevés  (288 points)
--   7d       tranches de 15 minutes, depuis les relevés (672 points)
--   30d      tranches d'1 heure : agrégats + heure en cours calculée à la volée (720 points)
-- Chaque tranche porte moyenne ET pic ; sur 1h / 6h, moyenne = pic = la valeur mesurée.
-- ---------------------------------------------------------------------------
create function public.get_series(_cloud_server_id uuid, _range text)
returns table (
  ts timestamptz, n integer,
  load1_avg real, load1_max real, load5_avg real, load15_avg real,
  cpu_pct_avg real, cpu_pct_max real,
  mem_used_pct_avg real, mem_used_pct_max real,
  swap_used_pct_avg real, swap_used_pct_max real,
  disk_used_pct_avg real, disk_used_pct_max real
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  _origin constant timestamptz := timestamptz '2000-01-01 00:00:00+00';
  _step   interval;
  _from   timestamptz;
  _tail   timestamptz;
begin
  case _range
    when '1h'  then _from := now() - interval '1 hour';
    when '6h'  then _from := now() - interval '6 hours';
    when '24h' then _from := now() - interval '24 hours'; _step := interval '5 minutes';
    when '7d'  then _from := now() - interval '7 days';   _step := interval '15 minutes';
    when '30d' then _from := now() - interval '30 days';  _step := interval '1 hour';
    else raise exception 'invalid range (1h, 6h, 24h, 7d, 30d)' using errcode = '22023';
  end case;

  if _range in ('1h', '6h') then
    return query
      select m.ts, 1, m.load1, m.load1, m.load5, m.load15, m.cpu_pct, m.cpu_pct,
             m.mem_used_pct, m.mem_used_pct, m.swap_used_pct, m.swap_used_pct, m.disk_used_pct, m.disk_used_pct
      from public.metrics m
      where m.cloud_server_id = _cloud_server_id and m.ts >= _from
      order by m.ts;

  elsif _range in ('24h', '7d') then
    return query
      select date_bin(_step, m.ts, _origin), count(*)::integer,
             avg(m.load1)::real, max(m.load1), avg(m.load5)::real, avg(m.load15)::real,
             avg(m.cpu_pct)::real, max(m.cpu_pct),
             avg(m.mem_used_pct)::real, max(m.mem_used_pct),
             avg(m.swap_used_pct)::real, max(m.swap_used_pct),
             avg(m.disk_used_pct)::real, max(m.disk_used_pct)
      from public.metrics m
      where m.cloud_server_id = _cloud_server_id and m.ts >= _from
      group by 1
      order by 1;

  else
    -- 30 jours : agrégats horaires, sauf l'heure la plus récente (et tout ce qui n'est pas encore agrégé),
    -- recalculée à la volée depuis les relevés. Sans aucun agrégat, tout vient des relevés bruts.
    _tail := coalesce(
      (select max(h.ts) from public.metrics_1h h
        where h.cloud_server_id = _cloud_server_id and h.ts >= date_bin(_step, _from, _origin)),
      date_bin(_step, _from, _origin));
    return query
      select h.ts, h.n, h.load1_avg, h.load1_max, h.load5_avg, h.load15_avg, h.cpu_pct_avg, h.cpu_pct_max,
             h.mem_used_pct_avg, h.mem_used_pct_max, h.swap_used_pct_avg, h.swap_used_pct_max,
             h.disk_used_pct_avg, h.disk_used_pct_max
      from public.metrics_1h h
      where h.cloud_server_id = _cloud_server_id and h.ts >= date_bin(_step, _from, _origin) and h.ts < _tail
      union all
      select date_bin(_step, m.ts, _origin), count(*)::integer,
             avg(m.load1)::real, max(m.load1), avg(m.load5)::real, avg(m.load15)::real,
             avg(m.cpu_pct)::real, max(m.cpu_pct),
             avg(m.mem_used_pct)::real, max(m.mem_used_pct),
             avg(m.swap_used_pct)::real, max(m.swap_used_pct),
             avg(m.disk_used_pct)::real, max(m.disk_used_pct)
      from public.metrics m
      where m.cloud_server_id = _cloud_server_id and m.ts >= _tail
      group by 1
      order by 1;
  end if;
end;
$$;

revoke all on function public.get_series(uuid, text) from public, anon;
grant execute on function public.get_series(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Planification (pg_cron) : agrégation toutes les 5 minutes, purge quotidienne à 03:17 UTC.
-- Ne fait jamais échouer la migration : si pg_cron est indisponible, l'interface signale l'absence
-- d'exécution (job_state) et get_series() continue de fonctionner depuis les relevés.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron with schema pg_catalog;
    exception when others then
      raise notice 'pg_cron non activable automatiquement : %', sqlerrm;
    end;
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.schedule('yellowscope-rollup', '*/5 * * * *', 'select public.rollup_metrics(interval ''3 hours'')');
      perform cron.schedule('yellowscope-purge', '17 3 * * *', 'select public.purge_old_data()');
    exception when others then
      raise notice 'planification pg_cron impossible : %', sqlerrm;
    end;
  else
    raise notice 'pg_cron absent : activez-le (Database > Extensions) puis relancez la migration de planification.';
  end if;
end;
$$;

-- Première agrégation sur tout l'historique déjà collecté.
select public.rollup_metrics(interval '40 days');
