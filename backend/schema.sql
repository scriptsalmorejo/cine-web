-- Cine Web — datos personales en Supabase.
-- El catálogo (data/seed.json, data/catalogo.json) sigue estático y no se replica aquí.
--
-- Los nombres de columna coinciden con el front (id, notas, actualizado_en, …).
-- No hay traducción salvo una, y esa ocurre en el cliente:
--   cine-web:v2 .misPlataformas  ↔  user_prefs.plataformas_contratadas
--
-- «Sin marcar» no es un estado: no hay fila, o la fila es un tombstone (borrado = true).
-- Ejecutar entero en el SQL Editor del proyecto (es idempotente).

-- ---------------------------------------------------------------------------
-- Lista personal
-- ---------------------------------------------------------------------------

create table if not exists public.user_titles (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  estado text not null,
  favorita boolean not null default false,
  puntuacion smallint,
  notas text not null default '',
  anadido_en timestamptz,
  visto_en timestamptz,
  temporada integer,
  plataformas jsonb not null default '[]'::jsonb,
  actualizado_en timestamptz not null default now(),
  borrado boolean not null default false,
  primary key (user_id, id),
  constraint user_titles_id_chk check (
    id ~ '^(tmdb:[0-9]+|local:[0-9a-fA-F-]{36}|t_[a-z0-9]+)$'
  ),
  constraint user_titles_estado_chk check (estado in ('pendiente', 'vista')),
  constraint user_titles_puntuacion_chk check (
    puntuacion is null or (puntuacion between 1 and 10)
  )
);

comment on table public.user_titles is
  'Fila de la lista del usuario. Mismos nombres que el elemento de lista del front.';
comment on column public.user_titles.id is
  'id del front: tmdb:<n> o local:<uuid>. t_<…> es el id legado de uid() en app.js.';
comment on column public.user_titles.notas is
  'Notas del usuario. Cadena vacía es un valor real: un borrado reciente gana.';
comment on column public.user_titles.actualizado_en is
  'Reloj de última escritura que ya sella el front en cada elemento. Last-write-wins.';
comment on column public.user_titles.borrado is
  'Tombstone cuando el título vuelve a Sin marcar. No existe el estado sin_marcar.';
comment on column public.user_titles.estado is
  'Solo pendiente o vista. Sin marcar = ausencia de fila viva.';

-- ---------------------------------------------------------------------------
-- Plataformas contratadas (perfil)
-- ---------------------------------------------------------------------------

create table if not exists public.user_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plataformas_contratadas text[] not null default '{}',
  actualizado_en timestamptz not null default now(),
  constraint user_prefs_plataformas_chk check (
    plataformas_contratadas <@ array[
      'Netflix',
      'Max',
      'Apple TV+',
      'Prime Video',
      'Disney+',
      'Movistar Plus+',
      'Filmin',
      'SkyShowtime'
    ]::text[]
  )
);

comment on table public.user_prefs is
  'Perfil. plataformas_contratadas es la copia en la nube de misPlataformas.';
comment on column public.user_prefs.plataformas_contratadas is
  'Alias canónicos. En el navegador el mismo array se llama misPlataformas.';

-- ---------------------------------------------------------------------------
-- Títulos que el usuario añade vía TMDB (la ficha no está en el catálogo estático)
-- ---------------------------------------------------------------------------

create table if not exists public.user_custom_titles (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  ficha jsonb not null,
  origen text not null default 'usuario',
  streaming_es jsonb not null default '[]'::jsonb,
  verificado_en timestamptz,
  actualizado_en timestamptz not null default now(),
  primary key (user_id, id),
  constraint user_custom_titles_id_chk check (
    id ~ '^(tmdb:[0-9]+|local:[0-9a-fA-F-]{36}|t_[a-z0-9]+)$'
  ),
  constraint user_custom_titles_origen_chk check (origen = 'usuario')
);

comment on table public.user_custom_titles is
  'Ficha añadida por el usuario. streaming_es y verificado_en los escribe solo la verificación.';
comment on column public.user_custom_titles.ficha is
  'Ficha de catálogo (titulo, sinopsis, póster…). No incluye notas de la lista.';
comment on column public.user_custom_titles.streaming_es is
  'Oferta en España. La actualiza la función verificacion, para todas las filas de ese id.';
comment on column public.user_custom_titles.verificado_en is
  'Null = pendiente de verificación. La cola pública solo ve id y titulo.';

create index if not exists user_custom_titles_sin_verificar_idx
  on public.user_custom_titles (id)
  where verificado_en is null;

-- ---------------------------------------------------------------------------
-- RLS: cada sesión solo ve sus filas. El service role (funciones) la salta.
-- ---------------------------------------------------------------------------

alter table public.user_titles enable row level security;
alter table public.user_prefs enable row level security;
alter table public.user_custom_titles enable row level security;

revoke all on table public.user_titles from anon, public;
revoke all on table public.user_prefs from anon, public;
revoke all on table public.user_custom_titles from anon, public;

grant select, insert, update, delete on table public.user_titles to authenticated;
grant select, insert, update, delete on table public.user_prefs to authenticated;
grant select, insert, update, delete on table public.user_custom_titles to authenticated;

drop policy if exists user_titles_leer_propio on public.user_titles;
drop policy if exists user_titles_insertar_propio on public.user_titles;
drop policy if exists user_titles_actualizar_propio on public.user_titles;
drop policy if exists user_titles_borrar_propio on public.user_titles;

create policy user_titles_leer_propio
  on public.user_titles for select
  to authenticated
  using (user_id = auth.uid());

create policy user_titles_insertar_propio
  on public.user_titles for insert
  to authenticated
  with check (user_id = auth.uid());

create policy user_titles_actualizar_propio
  on public.user_titles for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy user_titles_borrar_propio
  on public.user_titles for delete
  to authenticated
  using (user_id = auth.uid());

drop policy if exists user_prefs_leer_propio on public.user_prefs;
drop policy if exists user_prefs_insertar_propio on public.user_prefs;
drop policy if exists user_prefs_actualizar_propio on public.user_prefs;
drop policy if exists user_prefs_borrar_propio on public.user_prefs;

create policy user_prefs_leer_propio
  on public.user_prefs for select
  to authenticated
  using (user_id = auth.uid());

create policy user_prefs_insertar_propio
  on public.user_prefs for insert
  to authenticated
  with check (user_id = auth.uid());

create policy user_prefs_actualizar_propio
  on public.user_prefs for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy user_prefs_borrar_propio
  on public.user_prefs for delete
  to authenticated
  using (user_id = auth.uid());

drop policy if exists user_custom_titles_leer_propio on public.user_custom_titles;
drop policy if exists user_custom_titles_insertar_propio on public.user_custom_titles;
drop policy if exists user_custom_titles_actualizar_propio on public.user_custom_titles;
drop policy if exists user_custom_titles_borrar_propio on public.user_custom_titles;

create policy user_custom_titles_leer_propio
  on public.user_custom_titles for select
  to authenticated
  using (user_id = auth.uid());

create policy user_custom_titles_insertar_propio
  on public.user_custom_titles for insert
  to authenticated
  with check (user_id = auth.uid());

create policy user_custom_titles_actualizar_propio
  on public.user_custom_titles for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy user_custom_titles_borrar_propio
  on public.user_custom_titles for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Verificación de streaming. Solo service_role (la Edge Function).
-- listar no devuelve user_id, notas ni la ficha: únicamente id y titulo, deduplicados.
-- aplicar solo toca streaming_es y verificado_en, en todas las filas de ese id.
-- ---------------------------------------------------------------------------

create or replace function public.listar_verificacion_pendiente()
returns table (id text, titulo text)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.id,
    coalesce(
      max(t.ficha->>'titulo') filter (where coalesce(t.ficha->>'titulo', '') <> ''),
      ''
    ) as titulo
  from public.user_custom_titles as t
  where t.verificado_en is null
  group by t.id
  order by t.id;
$$;

create or replace function public.aplicar_verificacion(
  p_id text,
  p_streaming_es jsonb,
  p_verificado_en timestamptz
)
returns integer
language sql
volatile
security definer
set search_path = public
as $$
  with upd as (
    update public.user_custom_titles
      set streaming_es = p_streaming_es,
          verificado_en = p_verificado_en
      where id = p_id
      returning 1
  )
  select count(*)::integer from upd;
$$;

revoke all on function public.listar_verificacion_pendiente() from public, anon, authenticated;
grant execute on function public.listar_verificacion_pendiente() to service_role;

revoke all on function public.aplicar_verificacion(text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.aplicar_verificacion(text, jsonb, timestamptz) to service_role;

comment on function public.listar_verificacion_pendiente() is
  'Cola de verificación: solo id y titulo, deduplicado entre usuarios. Sin datos personales.';
comment on function public.aplicar_verificacion(text, jsonb, timestamptz) is
  'Escribe streaming_es y verificado_en en todas las filas con ese id. Devuelve el número de filas.';
