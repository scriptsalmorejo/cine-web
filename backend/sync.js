/**
 * Cine Web — sesión y sincronización con Supabase.
 * Módulo ES, sin build. No toca la lista si no hay sesión.
 *
 * Los campos de la lista viajan con el mismo nombre que en el front
 * (id, notas, actualizado_en, …). La única traducción es:
 *   state.db.misPlataformas  ↔  user_prefs.plataformas_contratadas
 *
 * Configura `config.url` y `config.anonKey` (clave anónima, pública).
 * La service role y TMDB_API_KEY no viven aquí: RLS y las Edge Functions.
 */
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm";
import {
  cacheKey,
  fichaVisible,
  mergeCustomTitles,
  mergePrefs,
  mergeUserTitles,
  planCustom,
  planLocalPrefs,
  planLocalRows,
  prefsCloudALocal,
  prefsLocalACloud,
  syncMode,
} from "./merge.js";

export const config = {
  url: "https://rqfahwijrtenxijawmyn.supabase.co",
  anonKey: "sb_publishable_2FvW_TYWHI9vMmI0zo3ePQ_zqRt0ycj",
  redirectTo: "https://scriptsalmorejo.github.io/cine-web/",
};

const ACTIVE_USER_KEY = "cine-web:sync:v1:active-user";
const CHUNK = 200;

let client = null;
let redirectTo = config.redirectTo;
const memory = new Map();

function memoryStore() {
  return {
    getItem(key) {
      return memory.has(key) ? memory.get(key) : null;
    },
    setItem(key, value) {
      memory.set(key, String(value));
    },
    removeItem(key) {
      memory.delete(key);
    },
  };
}

function store() {
  try {
    if (typeof localStorage === "undefined") return memoryStore();
    return localStorage;
  } catch {
    return memoryStore();
  }
}

function readJson(key) {
  try {
    const raw = store().getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  store().setItem(key, JSON.stringify(value));
}

function readActive() {
  const value = readJson(ACTIVE_USER_KEY);
  return typeof value === "string" ? value : null;
}

function writeActive(userId) {
  writeJson(ACTIVE_USER_KEY, userId);
}

function readRows(userId, kind) {
  const parsed = readJson(cacheKey(userId, kind));
  return parsed && Array.isArray(parsed.rows) ? parsed.rows : [];
}

function writeRows(userId, kind, rows) {
  writeJson(cacheKey(userId, kind), { rows });
}

function putCachedRow(userId, kind, row) {
  const rows = readRows(userId, kind).filter((item) => item.id !== row.id);
  rows.push(row);
  writeRows(userId, kind, rows);
}

function mensaje(err) {
  if (!err) return "Error desconocido";
  if (typeof err === "string") return err;
  return err.message || "Error desconocido";
}

function sinSesion(state) {
  return {
    ok: true,
    skipped: true,
    applied: false,
    lista: Array.isArray(state.lista) ? state.lista : [],
    fichas: state.fichas && typeof state.fichas === "object" ? state.fichas : {},
    seedIds: state.seedIds,
    migracion: state.migracion ?? null,
    misPlataformas: state.misPlataformas,
  };
}

async function usuarioActivo() {
  if (!client) return null;
  const { data } = await client.auth.getSession();
  if (!data.session?.user) return null;
  const { data: fresh, error } = await client.auth.getUser();
  if (error || !fresh.user) return null;
  return fresh.user;
}

async function fetchTitles() {
  const { data, error } = await client
    .from("user_titles")
    .select("id, estado, favorita, puntuacion, notas, anadido_en, visto_en, temporada, plataformas, actualizado_en, borrado");
  if (error) throw error;
  return data || [];
}

async function fetchCustom() {
  const { data, error } = await client
    .from("user_custom_titles")
    .select("id, ficha, origen, streaming_es, verificado_en, actualizado_en");
  if (error) throw error;
  return data || [];
}

async function fetchPrefs() {
  const { data, error } = await client
    .from("user_prefs")
    .select("plataformas_contratadas, actualizado_en")
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function upsertChunks(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await client.from(table).upsert(rows.slice(i, i + CHUNK), { onConflict });
    if (error) return error;
  }
  return null;
}

function fichasSinUsuario(fichas) {
  const out = {};
  for (const [id, ficha] of Object.entries(fichas || {})) {
    if (ficha?.origen === "usuario" || String(id).startsWith("local:")) continue;
    out[id] = ficha;
  }
  return out;
}

function overlayFichas(base, customFichas) {
  const fichas = { ...base };
  for (const ficha of customFichas) {
    fichas[ficha.id] = { ...(fichas[ficha.id] || {}), ...ficha };
  }
  return fichas;
}

export async function init(overrides = {}) {
  const url = String(overrides.url ?? config.url ?? "").trim();
  const anonKey = String(overrides.anonKey ?? config.anonKey ?? "").trim();
  redirectTo = overrides.redirectTo || config.redirectTo;
  if (!url || !anonKey) {
    client = null;
    return { configured: false, user: null };
  }
  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  });
  const { data } = await client.auth.getSession();
  return { configured: true, user: data.session?.user ?? null };
}

/** Enlace mágico. La sesión llega al volver a redirectTo. */
export async function login(email) {
  const address = String(email || "").trim();
  if (!client) return { ok: false, skipped: true, reason: "sin_config" };
  if (!address) return { ok: false, error: "Falta el email" };
  const { error } = await client.auth.signInWithOtp({
    email: address,
    options: { emailRedirectTo: redirectTo },
  });
  if (error) return { ok: false, error: mensaje(error) };
  return { ok: true, pending: true };
}

/** Google es opcional: el proyecto tiene que tener el proveedor activado. */
export async function loginGoogle() {
  if (!client) return { ok: false, skipped: true, reason: "sin_config" };
  const { error } = await client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo },
  });
  if (error) return { ok: false, error: mensaje(error) };
  return { ok: true };
}

export async function logout() {
  if (!client) return { ok: false, skipped: true };
  const { error } = await client.auth.signOut();
  if (error) return { ok: false, error: mensaje(error) };
  return { ok: true };
}

export function onAuthChange(callback) {
  if (!client) return () => {};
  const { data } = client.auth.onAuthStateChange((event, session) => {
    callback({ event, session, user: session?.user ?? null });
  });
  return () => data.subscription.unsubscribe();
}

export async function pull() {
  const user = await usuarioActivo();
  if (!user) return { ok: false, skipped: true, lista: null, fichas: null, misPlataformas: null };
  try {
    const [titles, custom, prefs] = await Promise.all([fetchTitles(), fetchCustom(), fetchPrefs()]);
    const merged = mergeUserTitles({ localRows: [], remoteRows: titles, order: [] });
    const fichas = {};
    for (const row of custom) {
      const visible = fichaVisible(row);
      fichas[visible.id] = visible;
    }
    const view = prefsCloudALocal(prefs);
    return {
      ok: true,
      lista: merged.lista,
      fichas,
      misPlataformas: view.misPlataformas,
      actualizado_en: view.actualizado_en,
    };
  } catch (err) {
    return { ok: false, error: mensaje(err), lista: null, fichas: null, misPlataformas: null };
  }
}

/**
 * cambio:
 *  - { op: "upsert", item, ficha? }
 *  - { op: "borrar", id, actualizado_en? }
 *  - { op: "vaciar", ids, actualizado_en? }
 * Sin sesión no escribe y no cambia la caché.
 */
export async function push(cambio) {
  const user = await usuarioActivo();
  if (!user) return { ok: false, skipped: true };
  if (syncMode({ activeUserId: readActive(), userId: user.id }) === "adoptar-nube") {
    return { ok: false, skipped: true, reason: "otra-cuenta" };
  }
  const now = new Date().toISOString();
  try {
    if (cambio?.op === "vaciar") {
      const when = cambio.actualizado_en || now;
      const cache = readRows(user.id, "titles");
      const ids = new Set([
        ...(cambio.ids || []).map(String),
        ...cache.filter((row) => !row.borrado).map((row) => String(row.id)),
      ]);
      const byId = new Map(cache.map((row) => [String(row.id), row]));
      const tombstones = [];
      for (const id of ids) {
        if (!id) continue;
        const prev = byId.get(id);
        if (prev?.borrado) {
          tombstones.push(prev);
          continue;
        }
        const live = prev || { id, estado: "pendiente", notas: "", borrado: false };
        const [row] = planLocalRows({ lista: [], cache: [live], now: when });
        if (row?.borrado) tombstones.push(row);
      }
      const error = await upsertChunks(
        "user_titles",
        tombstones.map((row) => ({ ...row, user_id: user.id })),
        "user_id,id",
      );
      if (error) return { ok: false, error: mensaje(error) };
      const next = readRows(user.id, "titles").filter((row) => !ids.has(String(row.id)));
      writeRows(user.id, "titles", next.concat(tombstones));
      writeActive(user.id);
      return { ok: true, op: "vaciar", n: tombstones.length };
    }

    if (cambio?.op === "borrar") {
      const id = String(cambio.id || "");
      if (!id) return { ok: false, error: "Falta el id" };
      const when = cambio.actualizado_en || now;
      const prev = readRows(user.id, "titles").find((row) => row.id === id);
      const planned = planLocalRows({ lista: [], cache: prev ? [prev] : [{ id, estado: "pendiente", borrado: false }], now: when });
      const row = planned.find((item) => item.borrado);
      if (!row) return { ok: false, error: "No se pudo preparar el borrado" };
      const error = await upsertChunks("user_titles", [{ ...row, user_id: user.id }], "user_id,id");
      if (error) return { ok: false, error: mensaje(error) };
      putCachedRow(user.id, "titles", row);
      writeActive(user.id);
      return { ok: true, op: "borrar", id };
    }

    if (cambio?.op === "upsert") {
      const item = cambio.item;
      if (!item?.id) return { ok: false, error: "Falta el item" };
      const [row] = planLocalRows({ lista: [item], cache: [], now: item.actualizado_en || now });
      const error = await upsertChunks("user_titles", [{ ...row, user_id: user.id }], "user_id,id");
      if (error) return { ok: false, error: mensaje(error) };
      putCachedRow(user.id, "titles", row);
      if (cambio.ficha) {
        const ficha = { ...cambio.ficha, id: item.id, origen: cambio.ficha.origen || "usuario" };
        const [custom] = planCustom({ [item.id]: ficha }, readRows(user.id, "custom"), now);
        if (custom) {
          const customError = await upsertChunks(
            "user_custom_titles",
            [{ id: custom.id, ficha: custom.ficha, origen: "usuario", actualizado_en: custom.actualizado_en, user_id: user.id }],
            "user_id,id",
          );
          if (customError) return { ok: false, error: mensaje(customError) };
          putCachedRow(user.id, "custom", custom);
        }
      }
      writeActive(user.id);
      return { ok: true, op: "upsert", id: row.id };
    }

    return { ok: false, error: "cambio no reconocido" };
  } catch (err) {
    return { ok: false, error: mensaje(err) };
  }
}

/**
 * Fusiona la lista local con la nube. Sin sesión devuelve el mismo estado
 * y no escribe. Cambiar de cuenta adopta la nube y no sube la lista anterior.
 */
export async function syncAll(localState) {
  const state = localState && typeof localState === "object" ? localState : {};
  if (!client) return sinSesion(state);
  const user = await usuarioActivo();
  if (!user) return sinSesion(state);

  const base = {
    lista: Array.isArray(state.lista) ? state.lista : [],
    fichas: state.fichas && typeof state.fichas === "object" ? state.fichas : {},
    seedIds: state.seedIds,
    migracion: state.migracion ?? null,
    misPlataformas: state.misPlataformas,
  };

  let remoteTitles;
  let remoteCustom;
  let remotePrefs;
  try {
    [remoteTitles, remoteCustom, remotePrefs] = await Promise.all([
      fetchTitles(),
      fetchCustom(),
      fetchPrefs(),
    ]);
  } catch (err) {
    return { ok: false, skipped: false, applied: false, error: mensaje(err), ...base };
  }

  const now = new Date().toISOString();
  const mode = syncMode({ activeUserId: readActive(), userId: user.id });

  if (mode === "adoptar-nube") {
    writeRows(user.id, "titles", remoteTitles);
    writeRows(user.id, "custom", remoteCustom);
    if (remotePrefs) writeJson(cacheKey(user.id, "prefs"), prefsCloudALocal(remotePrefs));
    writeActive(user.id);
    const merged = mergeUserTitles({ localRows: [], remoteRows: remoteTitles, order: [] });
    const fichasCustom = remoteCustom.map(fichaVisible);
    return {
      ok: true,
      skipped: false,
      applied: true,
      switched: true,
      lista: merged.lista,
      fichas: overlayFichas(fichasSinUsuario(base.fichas), fichasCustom),
      seedIds: base.seedIds,
      migracion: base.migracion,
      misPlataformas: remotePrefs ? prefsCloudALocal(remotePrefs).misPlataformas : null,
    };
  }

  const localRows = planLocalRows({
    lista: base.lista,
    cache: readRows(user.id, "titles"),
    now,
  });
  const merged = mergeUserTitles({
    localRows,
    remoteRows: remoteTitles,
    order: base.lista.map((item) => item && item.id).filter(Boolean),
  });
  if (merged.toUpsert.length) {
    const error = await upsertChunks(
      "user_titles",
      merged.toUpsert.map((row) => ({ ...row, user_id: user.id })),
      "user_id,id",
    );
    if (error) return { ok: false, skipped: false, applied: false, error: mensaje(error), ...base };
  }

  const localCustom = planCustom(base.fichas, readRows(user.id, "custom"), now);
  const custom = mergeCustomTitles({ localRows: localCustom, remoteRows: remoteCustom });
  if (custom.toUpsert.length) {
    const error = await upsertChunks(
      "user_custom_titles",
      custom.toUpsert.map((row) => ({ ...row, user_id: user.id })),
      "user_id,id",
    );
    if (error) return { ok: false, skipped: false, applied: false, error: mensaje(error), ...base };
  }

  const localPrefs = planLocalPrefs(
    base.misPlataformas,
    readJson(cacheKey(user.id, "prefs")),
    now,
  );
  const prefs = mergePrefs({ local: localPrefs, remote: remotePrefs });
  if (prefs.push && prefs.row) {
    const { error } = await client.from("user_prefs").upsert({
      plataformas_contratadas: prefs.row.plataformas_contratadas,
      actualizado_en: prefs.row.actualizado_en,
      user_id: user.id,
    }, { onConflict: "user_id" });
    if (error) return { ok: false, skipped: false, applied: false, error: mensaje(error), ...base };
  }

  writeRows(user.id, "titles", merged.rows);
  writeRows(user.id, "custom", custom.rows);
  const prefsView = prefs.push && prefs.row
    ? prefsCloudALocal(prefs.row)
    : remotePrefs
      ? prefsCloudALocal(remotePrefs)
      : null;
  if (prefsView) writeJson(cacheKey(user.id, "prefs"), prefsView);
  writeActive(user.id);

  return {
    ok: true,
    skipped: false,
    applied: true,
    switched: false,
    lista: merged.lista,
    fichas: overlayFichas(base.fichas, custom.fichas),
    seedIds: base.seedIds,
    migracion: base.migracion,
    misPlataformas: prefs.misPlataformas === undefined ? base.misPlataformas : prefs.misPlataformas,
  };
}

/** misPlataformas del front. Sin sesión no escribe. */
export async function savePrefs(misPlataformas) {
  const user = await usuarioActivo();
  if (!user) return { ok: false, skipped: true, misPlataformas: misPlataformas ?? null };
  if (syncMode({ activeUserId: readActive(), userId: user.id }) === "adoptar-nube") {
    return { ok: false, skipped: true, reason: "otra-cuenta" };
  }
  const row = prefsLocalACloud(misPlataformas ?? [], new Date().toISOString());
  const { error } = await client.from("user_prefs").upsert({
    plataformas_contratadas: row.plataformas_contratadas,
    actualizado_en: row.actualizado_en,
    user_id: user.id,
  }, { onConflict: "user_id" });
  if (error) return { ok: false, error: mensaje(error) };
  const view = prefsCloudALocal(row);
  writeJson(cacheKey(user.id, "prefs"), view);
  writeActive(user.id);
  return { ok: true, ...view };
}

export async function loadPrefs() {
  const user = await usuarioActivo();
  if (!user) return { ok: false, skipped: true, misPlataformas: null };
  try {
    const remote = await fetchPrefs();
    const view = prefsCloudALocal(remote);
    if (remote) writeJson(cacheKey(user.id, "prefs"), view);
    return { ok: true, ...view };
  } catch (err) {
    return { ok: false, error: mensaje(err), misPlataformas: null };
  }
}

/** Búsqueda TMDB (es-ES) a través de la Edge Function. Hace falta sesión. */
export async function buscar(q, opts = {}) {
  const user = await usuarioActivo();
  if (!user) return { ok: false, skipped: true, resultados: [] };
  const { data, error } = await client.functions.invoke("tmdb-search", {
    body: { q: String(q || ""), tipo: opts.tipo || "multi", page: opts.page || 1 },
  });
  if (error) return { ok: false, error: mensaje(error), resultados: [] };
  return { ok: true, resultados: data?.resultados || [], pagina: data?.pagina, total_paginas: data?.total_paginas };
}

const api = {
  config,
  init,
  login,
  loginGoogle,
  logout,
  onAuthChange,
  pull,
  push,
  syncAll,
  savePrefs,
  loadPrefs,
  buscar,
};

if (typeof globalThis !== "undefined") globalThis.CineSync = api;
