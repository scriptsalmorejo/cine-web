/**
 * Fusión last-write-wins de la lista personal.
 * Sin dependencias: la ejecutan las pruebas con `node` y la usa sync.js.
 *
 * Los campos de la lista no se renombran (id, notas, actualizado_en, …).
 * La única traducción de nombre es misPlataformas ↔ plataformas_contratadas,
 * en prefsLocalACloud / prefsCloudALocal.
 *
 * «Sin marcar» no se guarda: o no hay fila, o la fila lleva borrado = true.
 * Una cadena vacía o un null (notas, puntuacion) es un valor real: si su
 * actualizado_en es más reciente, gana y borra lo que hubiera en el otro lado.
 */

export const PLATAFORMAS = [
  "Netflix",
  "Max",
  "Apple TV+",
  "Prime Video",
  "Disney+",
  "Movistar Plus+",
  "Filmin",
  "SkyShowtime",
];

const ALIAS_PLATAFORMA = new Map([
  ["max amazon channel", "Max"],
  ["movistar plus", "Movistar Plus+"],
  ["movistar plus+", "Movistar Plus+"],
  ["movistar plus+ ficción total", "Movistar Plus+"],
  ["movistar plus+ ficcion total", "Movistar Plus+"],
]);

const CACHE_PREFIX = "cine-web:sync:v1:";

/** Clave de caché de una cuenta. Otra cuenta no puede leerla. */
export function cacheKey(userId, kind) {
  const id = String(userId || "").trim();
  if (!id) throw new Error("caché sin usuario");
  if (id.includes(":") || id.includes("/")) throw new Error("user id no válido");
  return `${CACHE_PREFIX}${id}:${kind}`;
}

/**
 * omitir: no hay sesión; no se toca el estado local.
 * fusionar: misma cuenta, o primera vez (sube lo local).
 * adoptar-nube: la sesión es de otra cuenta; no se sube la lista local.
 */
export function syncMode({ activeUserId, userId }) {
  if (!userId) return "omitir";
  if (activeUserId && activeUserId !== userId) return "adoptar-nube";
  return "fusionar";
}

export function canonicalPlataformas(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const key = String(raw || "").trim().toLowerCase();
    if (!key) continue;
    const canon = ALIAS_PLATAFORMA.get(key) || PLATAFORMAS.find((name) => name.toLowerCase() === key);
    if (!canon || seen.has(canon)) continue;
    seen.add(canon);
    out.push(canon);
  }
  return out;
}

/** misPlataformas (front) → fila de user_prefs. Única traducción de nombres. */
export function prefsLocalACloud(misPlataformas, actualizado_en) {
  return {
    plataformas_contratadas: canonicalPlataformas(misPlataformas),
    actualizado_en: actualizado_en || null,
  };
}

/** Fila de user_prefs → misPlataformas (front). */
export function prefsCloudALocal(row) {
  if (!row) return { misPlataformas: null, actualizado_en: null };
  return {
    misPlataformas: canonicalPlataformas(row.plataformas_contratadas),
    actualizado_en: row.actualizado_en || null,
  };
}

/**
 * Reloj de la fila. El front sella actualizado_en; si falta, visto_en || anadido_en.
 * Devuelve milisegundos, o -Infinity si no hay ninguna marca.
 */
export function timeOf(row) {
  if (!row) return Number.NEGATIVE_INFINITY;
  for (const key of ["actualizado_en", "visto_en", "anadido_en"]) {
    const value = row[key];
    if (!value) continue;
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return Number.NEGATIVE_INFINITY;
}

function stampOf(row) {
  if (!row) return null;
  for (const key of ["actualizado_en", "visto_en", "anadido_en"]) {
    if (row[key]) {
      const ms = Date.parse(row[key]);
      if (!Number.isNaN(ms)) return row[key];
    }
  }
  return null;
}

function cleanPuntuacion(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 10) return null;
  return n;
}

function cleanTemporada(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return n;
}

function estadoVivo(estado) {
  const raw = String(estado || "pendiente").toLowerCase();
  if (raw === "vista" || raw === "visto") return "vista";
  return "pendiente";
}

/** Fila viva con los mismos nombres que el elemento de lista del front. */
export function filaViva(item, fallbackStamp) {
  const actualizado = stampOf(item) || fallbackStamp || null;
  return {
    id: String(item.id),
    estado: estadoVivo(item.estado),
    favorita: Boolean(item.favorita),
    puntuacion: cleanPuntuacion(item.puntuacion),
    notas: item.notas == null ? "" : String(item.notas),
    anadido_en: item.anadido_en || null,
    visto_en: item.visto_en || null,
    temporada: cleanTemporada(item.temporada),
    plataformas: Array.isArray(item.plataformas) ? item.plataformas : [],
    actualizado_en: actualizado,
    borrado: false,
  };
}

function filaTombstone(prev, id, actualizado_en) {
  const base = prev && !prev.borrado ? filaViva(prev, actualizado_en) : {
    id: String(id),
    estado: prev?.estado === "vista" ? "vista" : "pendiente",
    favorita: Boolean(prev?.favorita),
    puntuacion: cleanPuntuacion(prev?.puntuacion),
    notas: prev?.notas == null ? "" : String(prev.notas),
    anadido_en: prev?.anadido_en || null,
    visto_en: prev?.visto_en || null,
    temporada: cleanTemporada(prev?.temporada),
    plataformas: Array.isArray(prev?.plataformas) ? prev.plataformas : [],
    actualizado_en,
  };
  return { ...base, id: String(id), borrado: true, actualizado_en };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value ?? null;
}

function sameJson(a, b) {
  return JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null));
}

/** Igualdad de contenido, sin el reloj. null y "" en notas cuentan como lo mismo. */
export function mismoContenido(a, b) {
  if (!a || !b) return false;
  return (
    String(a.id) === String(b.id) &&
    estadoVivo(a.estado) === estadoVivo(b.estado) &&
    Boolean(a.favorita) === Boolean(b.favorita) &&
    cleanPuntuacion(a.puntuacion) === cleanPuntuacion(b.puntuacion) &&
    String(a.notas || "") === String(b.notas || "") &&
    (a.anadido_en || null) === (b.anadido_en || null) &&
    (a.visto_en || null) === (b.visto_en || null) &&
    cleanTemporada(a.temporada) === cleanTemporada(b.temporada) &&
    sameJson(a.plataformas || [], b.plataformas || []) &&
    Boolean(a.borrado) === Boolean(b.borrado)
  );
}

function indexById(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row || row.id == null || row.id === "") continue;
    map.set(String(row.id), row);
  }
  return map;
}

/**
 * Convierte la lista local + la caché de esta cuenta en filas (con tombstones).
 * Respeta el actualizado_en que ya trae el front. Solo sella `now` en un
 * borrado detectado ahora, o si la fila no tiene ningún reloj.
 * No inventa tombstones para ids que nunca estuvieron en la caché de esta cuenta:
 * así un título que solo existe en la nube no se borra en el primer contacto.
 */
export function planLocalRows({ lista, cache, now }) {
  const cacheById = indexById(cache);
  const seen = new Set();
  const rows = [];

  for (const item of lista || []) {
    if (!item || item.id == null || item.id === "") continue;
    const id = String(item.id);
    seen.add(id);
    const cached = cacheById.get(id);
    const sinMarcar = item.estado === "sin_marcar" || item.borrado === true;
    if (sinMarcar) {
      const when = stampOf(item) || now;
      rows.push(filaTombstone(cached || item, id, when));
      continue;
    }
    let actualizado = stampOf({ actualizado_en: item.actualizado_en });
    if (!actualizado && cached && !cached.borrado && mismoContenido(item, cached)) {
      actualizado = stampOf(cached);
    }
    if (!actualizado) actualizado = stampOf(item) || now;
    rows.push(filaViva({ ...item, id, actualizado_en: actualizado }, now));
  }

  for (const [id, cached] of cacheById) {
    if (seen.has(id)) continue;
    if (cached.borrado) {
      rows.push({ ...cached, id, borrado: true });
      continue;
    }
    rows.push(filaTombstone(cached, id, now));
  }

  return rows;
}

function pickWinner(local, remote) {
  if (!local) return { row: remote, source: "remote" };
  if (!remote) return { row: local, source: "local" };
  if (timeOf(local) > timeOf(remote)) return { row: local, source: "local" };
  return { row: remote, source: "remote" };
}

function tituloParaSubir(row) {
  return {
    id: row.id,
    estado: row.estado === "vista" ? "vista" : "pendiente",
    favorita: Boolean(row.favorita),
    puntuacion: cleanPuntuacion(row.puntuacion),
    notas: row.notas == null ? "" : String(row.notas),
    anadido_en: row.anadido_en || null,
    visto_en: row.visto_en || null,
    temporada: cleanTemporada(row.temporada),
    plataformas: Array.isArray(row.plataformas) ? row.plataformas : [],
    actualizado_en: row.actualizado_en,
    borrado: Boolean(row.borrado),
  };
}

/** Elemento de lista para el front: mismos campos, sin user_id ni borrado. */
export function toListaItem(row) {
  const item = {
    id: row.id,
    estado: row.estado === "vista" ? "vista" : "pendiente",
    favorita: Boolean(row.favorita),
    puntuacion: cleanPuntuacion(row.puntuacion),
    notas: row.notas == null ? "" : String(row.notas),
    anadido_en: row.anadido_en || null,
    visto_en: row.visto_en || null,
    plataformas: Array.isArray(row.plataformas) ? row.plataformas : [],
    temporada: cleanTemporada(row.temporada),
    actualizado_en: row.actualizado_en || null,
  };
  return item;
}

/**
 * Fusiona filas locales (ya con tombstones) y filas remotas.
 * Empate de reloj: gana la nube, para no reescribir en bucle.
 * `order` conserva el orden de la lista local; los ids nuevos quedan al final.
 */
export function mergeUserTitles({ localRows, remoteRows, order }) {
  const local = indexById(localRows);
  const remote = indexById(remoteRows);
  const ids = [...new Set([...local.keys(), ...remote.keys()])].sort();
  const rows = [];
  const toUpsert = [];

  for (const id of ids) {
    const left = local.get(id) || null;
    const right = remote.get(id) || null;
    const winner = pickWinner(left, right);
    const row = tituloParaSubir(winner.row);
    rows.push(row);
    if (winner.source === "local") toUpsert.push(row);
  }

  const live = new Map(rows.filter((row) => !row.borrado).map((row) => [row.id, row]));
  const lista = [];
  const seen = new Set();
  for (const id of order || []) {
    const key = String(id);
    if (!live.has(key) || seen.has(key)) continue;
    lista.push(toListaItem(live.get(key)));
    seen.add(key);
  }
  for (const row of rows) {
    if (row.borrado || seen.has(row.id)) continue;
    lista.push(toListaItem(row));
    seen.add(row.id);
  }

  return { rows, lista, toUpsert };
}

/**
 * Preferencias. `local === null` significa que el front no trae `misPlataformas`
 * (no es un vaciado). Un array vacío sí es opinión: ninguna plataforma contratada.
 * Ambos lados usan { plataformas, actualizado_en } ya traducidos por el llamador
 * o, si viene la fila de nube, plataformas_contratadas.
 */
export function plataformasDe(row) {
  if (!row) return [];
  if (Array.isArray(row.misPlataformas)) return canonicalPlataformas(row.misPlataformas);
  return canonicalPlataformas(row.plataformas_contratadas || row.plataformas);
}

export function planLocalPrefs(misPlataformas, cache, now) {
  if (misPlataformas == null) return null;
  const plataformas = canonicalPlataformas(misPlataformas);
  const cached = cache ? canonicalPlataformas(plataformasDe(cache)) : null;
  const same = cached != null && sameJson(cached, plataformas);
  const actualizado_en = same && cache.actualizado_en ? cache.actualizado_en : now;
  return prefsLocalACloud(plataformas, actualizado_en);
}

export function mergePrefs({ local, remote }) {
  if (!local && !remote) {
    return { misPlataformas: undefined, row: null, push: false };
  }
  if (!local) {
    const view = prefsCloudALocal(remote);
    return { misPlataformas: view.misPlataformas, row: null, push: false };
  }
  if (!remote) {
    return { misPlataformas: plataformasDe(local), row: local, push: true };
  }
  if (timeOf(local) > timeOf(remote)) {
    return { misPlataformas: plataformasDe(local), row: local, push: true };
  }
  const view = prefsCloudALocal(remote);
  return { misPlataformas: view.misPlataformas, row: null, push: false };
}

function fichaUsuario(id, ficha) {
  const copy = { ...(ficha || {}) };
  delete copy.notas;
  delete copy.user_id;
  copy.id = String(id);
  copy.origen = "usuario";
  return copy;
}

/** Fichas que sí suben: origen usuario, o id local:. El catálogo estático no. */
export function planCustom(fichas, cache, now) {
  const cacheById = indexById(cache);
  const rows = [];
  for (const [id, ficha] of Object.entries(fichas || {})) {
    if (!ficha || typeof ficha !== "object") continue;
    const esUsuario = ficha.origen === "usuario" || String(id).startsWith("local:");
    if (!esUsuario) continue;
    const cached = cacheById.get(String(id));
    const fichaLimpia = fichaUsuario(id, ficha);
    let actualizado = ficha.actualizado_en || null;
    if (!actualizado && cached && sameJson(cached.ficha, fichaLimpia)) {
      actualizado = cached.actualizado_en || null;
    }
    if (!actualizado) actualizado = now;
    rows.push({
      id: String(id),
      ficha: fichaLimpia,
      origen: "usuario",
      actualizado_en: actualizado,
      streaming_es: cached?.streaming_es ?? (Array.isArray(ficha.streaming_es) ? ficha.streaming_es : []),
      verificado_en: cached?.verificado_en ?? ficha.verificado_en ?? null,
    });
  }
  return rows;
}

function verificationTime(row) {
  if (!row?.verificado_en) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(row.verificado_en);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** Ficha que ve el front: la verificación pisa streaming_es y verificado_en. */
export function fichaVisible(row) {
  const ficha = fichaUsuario(row.id, row.ficha);
  if (row.verificado_en) {
    ficha.streaming_es = Array.isArray(row.streaming_es) ? row.streaming_es : [];
    ficha.verificado_en = row.verificado_en;
  }
  ficha.actualizado_en = row.actualizado_en || ficha.actualizado_en || null;
  return ficha;
}

/**
 * La ficha se fusiona por actualizado_en. streaming_es y verificado_en van
 * por su propio reloj (verificado_en), para que un edit de la ficha no borre
 * una verificación más nueva, ni al revés.
 * toUpsert no incluye streaming_es ni verificado_en: eso solo lo escribe verificacion.
 */
export function mergeCustomTitles({ localRows, remoteRows }) {
  const local = indexById(localRows);
  const remote = indexById(remoteRows);
  const ids = [...new Set([...local.keys(), ...remote.keys()])].sort();
  const rows = [];
  const toUpsert = [];
  const fichas = [];

  for (const id of ids) {
    const left = local.get(id) || null;
    const right = remote.get(id) || null;
    const fichaSide = pickWinner(left, right);
    const base = fichaSide.row;
    let streaming_es = Array.isArray(base.streaming_es) ? base.streaming_es : [];
    let verificado_en = base.verificado_en || null;
    if (left && right) {
      const tl = verificationTime(left);
      const tr = verificationTime(right);
      const streamSide = tl > tr ? left : right;
      streaming_es = Array.isArray(streamSide.streaming_es) ? streamSide.streaming_es : [];
      verificado_en = streamSide.verificado_en || null;
    } else if (right && verificationTime(right) >= verificationTime(left)) {
      streaming_es = Array.isArray(right.streaming_es) ? right.streaming_es : [];
      verificado_en = right.verificado_en || null;
    }
    const row = {
      id,
      ficha: fichaUsuario(id, base.ficha),
      origen: "usuario",
      actualizado_en: base.actualizado_en || null,
      streaming_es,
      verificado_en,
    };
    rows.push(row);
    fichas.push(fichaVisible(row));
    if (fichaSide.source === "local") {
      toUpsert.push({
        id,
        ficha: row.ficha,
        origen: "usuario",
        actualizado_en: row.actualizado_en,
      });
    }
  }

  return { rows, fichas, toUpsert };
}

/**
 * Contrato de la cola de verificación: solo {id, titulo}, deduplicado.
 * Ignora user_id, notas y el resto de la ficha. No es lo que ejecuta la
 * base (eso es listar_verificacion_pendiente); fija el mismo resultado.
 */
export function proyectarPendientes(rows) {
  const byId = new Map();
  for (const row of rows || []) {
    if (!row || row.verificado_en) continue;
    const id = String(row.id || "").trim();
    if (!id) continue;
    const titulo = String(row.titulo || row.ficha?.titulo || "").trim();
    const prev = byId.get(id);
    if (!prev) byId.set(id, { id, titulo });
    else if (!prev.titulo && titulo) prev.titulo = titulo;
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
