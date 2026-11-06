# Backend de login y sync

Supabase (Auth, Postgres y Edge Functions) para la lista personal de Cine Web. El catálogo (`data/seed.json`, `data/catalogo.json`) sigue estático. En la nube solo va lo personal.

Este directorio no cambia `index.html`, `app.js` ni `styles.css`. Sin sesión, la web sigue igual: todo queda en `localStorage`.

## 1. Proyecto Supabase

1. Entra en [supabase.com](https://supabase.com) y crea un proyecto gratis.
2. Anota la **Project URL** (`https://<ref>.supabase.co`) y la clave **anon / public**. La anon key es pública: va en el front. La seguridad la da RLS.
3. No copies la **service role** al repositorio ni a `sync.js`. Solo vive en los secretos de las Edge Functions (Supabase la inyecta como `SUPABASE_SERVICE_ROLE_KEY`).

## 2. Esquema

En el SQL Editor del proyecto, pega y ejecuta [`schema.sql`](schema.sql) entero. Se puede repetir.

Crea tres tablas. Los nombres de columna son los del front (`id`, `notas`, `actualizado_en`, `anadido_en`, `visto_en`, `favorita`, `puntuacion`, `temporada`, `plataformas`):

| Tabla | Qué guarda |
| --- | --- |
| `user_titles` | Una fila de la lista. PK `(user_id, id)`. `estado` solo `pendiente` o `vista`. `borrado` es el tombstone de «Sin marcar». |
| `user_prefs` | `plataformas_contratadas` (el array que en el navegador se llama `misPlataformas`) y `actualizado_en`. |
| `user_custom_titles` | Ficha añadida por el usuario (`origen = 'usuario'`). `streaming_es` y `verificado_en` los escribe solo la verificación. |

RLS está activo. Cada política es `user_id = auth.uid()`. El rol `anon` no tiene permisos sobre las tablas.

`id` admite `tmdb:<número>`, `local:<uuid>` y el id legado `t_<…>` que hoy genera `uid()` en `app.js`. Los títulos nuevos a mano deberían usar `local:` + `crypto.randomUUID()`.

## 3. Auth

Authentication → Providers:

- **Email**: activo. No hace falta contraseña; el login es un enlace mágico (`signInWithOtp`).
- **Google**: opcional. Si no lo activas, `loginGoogle()` fallará y el email sigue funcionando.

Authentication → URL Configuration:

- Site URL: `https://scriptsalmorejo.github.io/cine-web/`
- Redirect URLs, añade también:
  - `https://scriptsalmorejo.github.io/cine-web/`
  - `http://localhost:8080`
  - `http://127.0.0.1:8080`

El enlace del correo tiene que volver a esa URL. `init()` usa PKCE y lee la sesión de la URL de vuelta.

## 4. Edge Functions y secretos

Hace falta el [Supabase CLI](https://supabase.com/docs/guides/cli) y un `supabase link` apuntando a este directorio (aquí está `supabase/config.toml`):

```bash
supabase login
supabase link --project-ref TU_REF --workdir backend
supabase secrets set --workdir backend \
  TMDB_API_KEY=tu_clave_v3_o_token \
  VERIFY_TOKEN="$(openssl rand -hex 32)"
```

`TMDB_API_KEY` es la clave de themoviedb.org (v3 en query, o un token de lectura que empiece por `ey`, enviado como Bearer). `VERIFY_TOKEN` es el secreto del worker de streaming. Ninguno de los dos sale del servidor.

```bash
supabase functions deploy tmdb-search --workdir backend
supabase functions deploy verificacion-pendientes --workdir backend
supabase functions deploy verificacion --workdir backend
```

`config.toml` deja `verify_jwt = false` en las dos de verificación (el worker no tiene JWT de usuario). `tmdb-search` exige JWT.

| Función | Método | Auth | Respuesta |
| --- | --- | --- | --- |
| `tmdb-search` | GET o POST `q`, `tipo` (`multi` / `pelicula` / `serie`), `page` | Usuario con sesión. Idioma `es-ES`, región `ES`. | `{ resultados, pagina, total_paginas }`. Cada resultado usa los campos de una ficha: `id` (`tmdb:<n>`), `tipo`, `titulo`, `titulo_original`, `anio`, `sinopsis`, `poster`, `backdrop`. |
| `verificacion-pendientes` | GET | Header `x-verify-token: $VERIFY_TOKEN` | Array `[{id, titulo}]`, deduplicado entre usuarios. Nada más: ni `user_id`, ni `notas`, ni la ficha. |
| `verificacion` | POST | El mismo header | Cuerpo `[{id, streaming_es, verificado_en}]`. Actualiza **solo** esas dos columnas, en **todas** las filas con ese `id`. Respuesta `{ ok, actualizados }`. |

El gateway pide también la anon key:

```bash
curl -s "$URL/functions/v1/verificacion-pendientes" \
  -H "apikey: $ANON" \
  -H "x-verify-token: $VERIFY_TOKEN"

curl -s "$URL/functions/v1/verificacion" \
  -H "apikey: $ANON" \
  -H "content-type: application/json" \
  -H "x-verify-token: $VERIFY_TOKEN" \
  -d '[{"id":"tmdb:550","streaming_es":[],"verificado_en":"2026-11-06T12:00:00Z"}]'
```

Desde el front, la búsqueda pasa por `CineSync.buscar("dune")`, que llama a la función con la sesión. No construyas la URL de TMDB en el navegador.

## 5. Configurar el cliente

En [`sync.js`](sync.js), rellena la URL y la anon key:

```js
export const config = {
  url: "https://TU_REF.supabase.co",
  anonKey: "eyJ…", // anon, pública
  redirectTo: "https://scriptsalmorejo.github.io/cine-web/",
};
```

Mientras estén vacías, `init()` responde `{ configured: false }` y el resto no llama a la red.

Carga el módulo **antes** de que se dispare `DOMContentLoaded` (el script clásico de `app.js` puede quedar delante o detrás; el módulo se aplaza y asigna `globalThis.CineSync`):

```html
<script type="module" src="backend/sync.js"></script>
<script src="app.js"></script>
```

`sync.js` importa `@supabase/supabase-js` 2.119.0 desde jsDelivr y `./merge.js`. No hay build.

## 6. Contrato de datos

Documento local, clave `cine-web:v2`:

```js
{
  fichas: { "tmdb:550": { /* ficha */ } },
  lista: [{
    id, estado, favorita, puntuacion, notas,
    anadido_en, visto_en, temporada, plataformas,
    actualizado_en   // el front ya lo sella en cada elemento
  }],
  seedIds, migracion,
  misPlataformas: ["Netflix", "Filmin"]  // única clave que se traduce
}
```

- **No hay traducción** de los campos de la lista. `sync.js` lee y escribe `id`, `notas`, `actualizado_en` y el resto con el mismo nombre.
- La única traducción es `misPlataformas` ↔ `user_prefs.plataformas_contratadas`. Alias canónicos: Netflix, Max, Apple TV+, Prime Video, Disney+, Movistar Plus+, Filmin, SkyShowtime. «Otra» y los nombres de tienda no se guardan. `Max Amazon Channel` y las variantes de Movistar se normalizan.
- **Sin marcar** no es un estado. No hay fila, o la fila tiene `borrado: true` (tombstone) para que otro dispositivo se entere. Nunca se escribe `estado: "sin_marcar"`.
- Fusión **last-write-wins por `id`**, con el `actualizado_en` del elemento. Si falta, se usa `visto_en` y, si tampoco está, `anadido_en`. Empate: gana la nube.
- Una nota vacía o una puntuación `null` es un valor. Si ese `actualizado_en` es más reciente, borra lo que hubiera en el otro lado. No se rellenan huecos campo a campo.
- `seedIds` y `migracion` no se sincronizan (son el libro del catálogo en este navegador).
- Las fichas del catálogo no se suben. Solo las de `origen: "usuario"` o con id `local:…`. Al pintarlas, `streaming_es` y `verificado_en` de la columna de verificación pisan a los de la ficha, con su propio reloj, para que un edit del título no borre una verificación más nueva.
- Caché por cuenta: `cine-web:sync:v1:<userId>:titles|custom|prefs`. No es `cine-web:v2` y no se lee la de otra cuenta. La primera sesión de un navegador sube la lista local. Si entra otra cuenta, `syncAll` devuelve `switched: true` y la lista de esa cuenta, sin subir la anterior.

Sin `client` o sin sesión, `syncAll` devuelve el estado que le pasaste, con `skipped: true` y `applied: false`.

## 7. Dónde engancharlo en `app.js`

`persist()` (línea 322) debe seguir siendo solo `Storage.save`. La red va en los puntos de abajo, después de que el front haya sellado `actualizado_en`.

`Storage.load` (137) reconstruye el documento y hoy no copia claves nuevas. `Storage.normalizeListaItem` (189) devuelve el objeto de las líneas 223-236 **sin** `actualizado_en`. Si eso no se conserva, `Storage.load` tira el reloj al recargar: un edit sin sello cae en `visto_en || anadido_en` y puede perder contra la nube. Al integrar:

- en el `return` de `normalizeListaItem`, añade `actualizado_en: raw.actualizado_en || null`;
- en el objeto que devuelve `load` (y en `importJSON`, 163, que pasa por el mismo normalizador), copia también `misPlataformas: Array.isArray(data.misPlataformas) ? data.misPlataformas : undefined`. `save` (155) ya serializa el `db` entero, así que con poner el array en `state.db` basta para que sobreviva al `persist`.

Arranque, dentro de `DOMContentLoaded` (1471), **después** de `ensureData()` (576) y antes de `renderAll()`:

```js
const sync = globalThis.CineSync;
const boot = await sync.init();
if (boot.user) {
  const remoto = await sync.syncAll(state.db);
  if (remoto.applied) {
    state.db.lista = remoto.lista;
    state.db.fichas = remoto.fichas;
    if (remoto.misPlataformas) state.db.misPlataformas = remoto.misPlataformas;
    persist();
    if (remoto.switched) toast("Sesión de otra cuenta: cargada su lista");
  }
}
renderAll();
```

`init()` también recoge el enlace mágico si la página se abrió desde el correo. `onAuthChange` sirve para un botón de entrar / salir que el front dibuje; hay que registrarlo después de `init()`.

Mutaciones, cuando el elemento ya tiene `actualizado_en` nuevo y se ha llamado a `persist()`:

| Qué hace el usuario | Función | Llamada |
| --- | --- | --- |
| Formulario (alta, edición, notas vaciadas, puntuación borrada) | `addOrUpdateFromForm` (620) | `sync.push({ op: "upsert", item: row, ficha })` |
| Añadir desde catálogo | `addFichaToLista` (684), `addFromExplorar` (700) | `sync.push({ op: "upsert", item })` |
| Vista / pendiente | `toggleEstado` (752) | `sync.push({ op: "upsert", item: t })` |
| Favorita | `toggleFavorita` (765) | `sync.push({ op: "upsert", item: t })` |
| Quitar de la lista (vuelve a Sin marcar) | `borrarDeLista` (747) | antes de filtrar: `sync.push({ op: "borrar", id, actualizado_en })` |
| Vaciar mi lista | `#btn-reseedar` (1302) → `aplicarEstadoFresco` (513) | guarda `ids = state.db.lista.map(t => t.id)` **antes** de vaciar; luego `sync.push({ op: "vaciar", ids, actualizado_en })` |
| Importar JSON | `#file-import` (1278), tras el merge y `persist()` | `sync.syncAll(state.db)` y adopta `lista` / `fichas` si `applied` |

`ficha` solo en el upsert de un título que no está en el catálogo, con `origen: "usuario"`. El catálogo que `aplicarEstadoFresco` copia en `state.db.fichas` no se sube.

Plataformas contratadas (aún no hay UI): cuando exista, guarda el array en `state.db.misPlataformas` y llama a `sync.savePrefs(state.db.misPlataformas)`. Al arrancar, si `loadPrefs()` devuelve un array, escríbelo en `state.db.misPlataformas`. Un array vacío significa «no tengo ninguna»; no mandes la clave si el usuario no ha elegido, porque entonces no es un vaciado.

`logout()` cierra la sesión y no borra `cine-web:v2` ni la caché de esa cuenta. La lista local sigue en el navegador.

## 8. Seguridad

- La anon key puede estar en el repositorio. Sin una política que cumpla `auth.uid()`, PostgREST no devuelve filas.
- La service role, `TMDB_API_KEY` y `VERIFY_TOKEN` no se incrustan en el front ni en `sync.js`.
- `listar_verificacion_pendiente` y `aplicar_verificacion` solo las ejecuta `service_role`. La primera proyecta `id` y `titulo`. La segunda no toca `ficha`, `notas` ni `user_id`.
- Las funciones de verificación contestan con ese array o con `{ ok, actualizados }`. No reenvían la fila.

## 9. Pruebas

Sin dependencias, desde la raíz del repo:

```bash
node --test backend/merge.test.js
```

Cubren la fusión (reloj, notas vacías, tombstones, empates), la traducción de `misPlataformas`, las cachés por usuario y que el SQL de verificación no proyecta datos personales.
