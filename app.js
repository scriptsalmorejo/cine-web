/**
 * Cine Web — fichas (catálogo) + lista (usuario).
 * Campos de lista: estado, favorita, puntuacion (1-10), notas, anadido_en, visto_en,
 * plataformas[] (snapshot subscription), temporada? (serie).
 * Storage aislado para poder sustituir por backend.
 */

const PLATAFORMAS_ES = [
  "Netflix",
  "Max",
  "Apple TV+",
  "Prime Video",
  "Disney+",
  "Movistar Plus+",
  "Filmin",
  "SkyShowtime",
];

const TIPO_STREAM = {
  subscription: "Suscripción",
  rent: "Alquiler",
  buy: "Compra",
};

const MOBLAND_ID = "tmdb:247718";
const MIGRACION_SIN_MARCAR = "sin-marcar-1";

/** Alias para filtro: nombre mostrado → canónicos que también hacen match */
const FILTRO_ALIAS = {
  Max: ["Max", "Max Amazon Channel"],
  "Movistar Plus+": [
    "Movistar Plus+",
    "Movistar Plus+ Ficción Total",
    "Movistar Plus+ Ficcion Total",
  ],
};

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return "local:" + crypto.randomUUID();
  return "local:" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Nombre canónico para snapshot de suscripción (lista/chips). */
function normalizarNombreSuscripcion(nombre) {
  const n = String(nombre || "").trim();
  if (/^Max Amazon Channel$/i.test(n)) return "Max";
  if (/^Movistar Plus\+?/i.test(n) || /Movistar Plus\+?\s+Ficci[oó]n Total/i.test(n)) {
    return "Movistar Plus+";
  }
  return n;
}

/** ¿La entrada de streaming es solo tienda (alquiler/compra)? */
function esTiendaAlquilerCompra(nombre) {
  const n = String(nombre || "");
  return (
    n === "Amazon Video" ||
    n === "Apple TV Store" ||
    n === "Rakuten TV" ||
    /Store$/i.test(n)
  );
}

function snapshotPlataformasDesdeStreaming(streamingEs) {
  const byName = new Map();
  for (const s of streamingEs || []) {
    if (s.tipo !== "subscription" || esTiendaAlquilerCompra(s.plataforma)) continue;
    const nombre = normalizarNombreSuscripcion(s.plataforma);
    if (!nombre || nombre.toLowerCase() === "cine") continue;
    const verificacion = String(s.estado || "").toLowerCase() === "verificado" ? "verificado" : "por verificar";
    const previous = byName.get(nombre);
    // No ocultar una oferta sin verificar al deduplicar las marcas de la tarjeta.
    if (!previous || verificacion === "por verificar") byName.set(nombre, { nombre, verificacion });
  }
  return [...byName.values()];
}

/** Los snapshots manuales también contienen exclusivamente suscripciones. */
function plataformasCanonicas(plataformas) {
  return snapshotPlataformasDesdeStreaming((plataformas || []).map((p) => ({
    plataforma: p.nombre, tipo: "subscription", estado: p.verificacion,
  })));
}

function agruparStreamingParaFicha(streamingEs) {
  // Separar por modalidad ANTES de agrupar: una marca puede ofrecer tanto
  // suscripción como alquiler, pero cada oferta vive solo en su sección.
  const groups = { suscripcion: new Map(), alquilerCompra: new Map() };
  for (const s of streamingEs || []) {
    const nombre = normalizarNombreSuscripcion(s.plataforma);
    if (!nombre || nombre.toLowerCase() === "cine") continue;
    const section = s.tipo === "subscription" && !esTiendaAlquilerCompra(s.plataforma)
      ? "suscripcion" : ["rent", "buy"].includes(s.tipo) ? "alquilerCompra" : null;
    if (!section) continue;
    const origen = String(s.plataforma_original || s.plataforma).trim();
    const nota = /^Max Amazon Channel$/i.test(origen)
      ? "vía Amazon Channel"
      : /Ficci[oó]n Total/i.test(origen) ? "Ficción Total" : "";
    const verificacion = String(s.estado || "").toLowerCase() === "verificado" ? "verificado" : "por verificar";
    if (!groups[section].has(nombre)) groups[section].set(nombre, { nombre, ofertas: [] });
    const group = groups[section].get(nombre);
    // URLs, vías de acceso y verificación diferentes aportan información.
    // Las ofertas idénticas de alquiler y compra comparten un enlace.
    let oferta = group.ofertas.find((o) => o.url === (s.url || "") && o.nota === nota && o.verificacion === verificacion);
    if (!oferta) {
      oferta = { url: s.url || "", nota, verificacion, tipos: [], etiquetas: [] };
      group.ofertas.push(oferta);
    }
    if (!oferta.tipos.includes(s.tipo)) {
      oferta.tipos.push(s.tipo);
      oferta.etiquetas.push(TIPO_STREAM[s.tipo]);
    }
  }
  return {
    suscripcion: [...groups.suscripcion.values()],
    alquilerCompra: [...groups.alquilerCompra.values()],
  };
}

function plataformaCoincideFiltro(nombreEnLista, filtro) {
  if (filtro === "todas") return true;
  if (normalizarNombreSuscripcion(nombreEnLista) === normalizarNombreSuscripcion(filtro)) return true;
  const aliases = FILTRO_ALIAS[filtro];
  if (aliases && aliases.includes(nombreEnLista)) return true;
  // Si el chip es "Max Amazon Channel" y filtro es Max
  if (filtro === "Max" && nombreEnLista === "Max Amazon Channel") return true;
  return false;
}

const ORDENES = ["recientes", "titulo_asc", "cines_primero", "puntuacion_desc"];
function normalizarOrden(orden) {
  return ORDENES.includes(orden) ? orden : "recientes";
}
function normalizarMisPlataformas(plataformas) {
  if (!Array.isArray(plataformas)) return [];
  const values = plataformas.filter((p) => typeof p === "string")
    .map(normalizarNombreSuscripcion)
    .filter((p) => p && p.toLowerCase() !== "cine" && !esTiendaAlquilerCompra(p))
    .map((p) => PLATAFORMAS_ES.find((name) => name.toLowerCase() === p.toLowerCase()) || "Otra");
  return [...new Set(values)];
}
function actualizadoAhora(row) {
  const previous = Date.parse(row?.actualizado_en || "");
  return new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
}

/* ---------- Storage ---------- */
const Storage = (() => {
  const KEY = "cine-web:v2";

  function empty() {
    return { fichas: {}, lista: [], seedIds: [], migracion: null, misPlataformas: [], orden: "recientes" };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return null;
      if (!data.fichas || !Array.isArray(data.lista)) return null;
      return {
        fichas: data.fichas,
        lista: data.lista.map((row) => normalizeListaItem(row)),
        seedIds: Array.isArray(data.seedIds) ? data.seedIds.map(String) : null,
        migracion: data.migracion || null,
        misPlataformas: normalizarMisPlataformas(data.misPlataformas),
        orden: normalizarOrden(data.orden),
      };
    } catch {
      return null;
    }
  }

  function save(db) {
    localStorage.setItem(KEY, JSON.stringify(db));
  }

  function exportJSON(db) {
    return JSON.stringify(db, null, 2);
  }

  function importJSON(text) {
    const data = JSON.parse(text);
    // Formato v2 {fichas, lista}
    if (data && data.fichas && Array.isArray(data.lista)) {
      return {
        fichas: data.fichas,
        lista: data.lista.map((row) =>
          normalizeListaItem(row, { mapViendoAPendiente: true })
        ),
        seedIds: Array.isArray(data.seedIds) ? data.seedIds.map(String) : [],
        migracion: data.migracion || null,
        misPlataformas: normalizarMisPlataformas(data.misPlataformas),
        orden: data.orden ? normalizarOrden(data.orden) : null,
      };
    }
    // Array plano legado → migrar a lista (+ fichas mínimas)
    if (Array.isArray(data)) {
      const fichas = {};
      const lista = data.map((raw) => {
        const item = normalizeListaItem(raw, { mapViendoAPendiente: true });
        fichas[item.id] = fichaFromLegacy(raw);
        return item;
      });
      return { fichas, lista, seedIds: [], migracion: null, misPlataformas: [], orden: null };
    }
    throw new Error("JSON no reconocido (se espera {fichas, lista} o un array)");
  }

  function normalizeListaItem(raw, opts = {}) {
    const mapViendo = Boolean(opts.mapViendoAPendiente);
    const estadoRaw = String(raw.estado || "pendiente").toLowerCase();
    // UI solo pendiente|vista. 'viendo' (legado/import) → pendiente.
    let estado = "pendiente";
    if (estadoRaw === "vista" || estadoRaw === "visto") estado = "vista";
    else if (estadoRaw === "viendo") estado = "pendiente";
    void mapViendo; // flag reservado por si el import quiere logging distinto

    let puntuacion = raw.puntuacion ?? raw.valoracion ?? null;
    if (puntuacion != null && puntuacion !== "") {
      puntuacion = Number(puntuacion);
      if (Number.isNaN(puntuacion)) puntuacion = null;
      else {
        if (puntuacion <= 5 && raw.valoracion != null && raw.puntuacion == null) {
          puntuacion = Math.round(puntuacion * 2);
        }
        puntuacion = Math.min(10, Math.max(1, puntuacion));
      }
    } else puntuacion = null;

    const plataformas = Array.isArray(raw.plataformas)
      ? raw.plataformas
          .map((p) => {
            if (typeof p === "string") return { nombre: p, verificacion: "por verificar" };
            const v = String(p.verificacion || p.estado || "por verificar").toLowerCase();
            return {
              nombre: String(p.nombre || "").trim(),
              verificacion: v === "verificado" ? "verificado" : "por verificar",
            };
          })
          .filter((p) => p.nombre)
      : [];

    const anadido = raw.anadido_en || raw.fechaAñadido || raw.fechaAnadido || new Date().toISOString();
    const updated = Date.parse(raw.actualizado_en || anadido);
    return {
      id: String(raw.id || uid()),
      estado,
      favorita: Boolean(raw.favorita),
      puntuacion,
      notas: String(raw.notas || ""),
      anadido_en: anadido,
      actualizado_en: Number.isFinite(updated) ? new Date(updated).toISOString() : new Date().toISOString(),
      visto_en: raw.visto_en || raw.fechaVista || null,
      plataformas,
      temporada: (() => {
        if (raw.temporada == null || raw.temporada === "") return null;
        const n = Math.trunc(Number(raw.temporada));
        return Number.isFinite(n) && n >= 0 ? n : null;
      })(),
      episodio: (() => {
        if (raw.episodio == null || raw.episodio === "") return null;
        const n = Math.trunc(Number(raw.episodio));
        return Number.isFinite(n) && n >= 0 ? n : null;
      })(),
    };
  }

  function fichaFromLegacy(raw) {
    const enCines = Boolean(raw.en_cines || raw.en_cartelera);
    return {
      id: String(raw.id || uid()),
      tipo: raw.tipo === "serie" ? "serie" : "pelicula",
      titulo: String(raw.titulo || "").trim(),
      titulo_original: raw.titulo_original || "",
      anio: raw.anio != null ? Number(raw.anio) : null,
      generos: Array.isArray(raw.generos) ? raw.generos.map(String) : [],
      sinopsis: String(raw.sinopsis || ""),
      poster: raw.poster || "",
      backdrop: raw.backdrop || "",
      extras_info: raw.extras_info && typeof raw.extras_info === "object" ? { ...raw.extras_info } : {},
      trailer: raw.trailer || "",
      streaming_es: Array.isArray(raw.streaming_es) ? raw.streaming_es : [],
      duracion: raw.duracion && typeof raw.duracion === "object"
        ? { ...raw.duracion } : raw.duracion != null ? Number(raw.duracion) : null,
      temporadas: raw.temporadas != null ? Number(raw.temporadas)
        : raw.duracion?.temporadas != null ? Number(raw.duracion.temporadas) : null,
      temporada_interes: raw.temporada_interes != null ? Number(raw.temporada_interes) : null,
      nota: raw.nota || "",
      fuentes: raw.fuentes || [],
      verificado_en: raw.verificado_en || null,
      en_cines: enCines,
      estreno_es: raw.estreno_es || null,
      popularidad_fuente: raw.popularidad_fuente || "",
    };
  }

  function fichaFromSeed(raw) {
    return fichaFromLegacy(raw);
  }

  function listaFromSeedFicha(ficha) {
    const now = new Date().toISOString();
    const isMob =
      ficha.id === "tmdb:247718" ||
      (ficha.temporada_interes != null && Number(ficha.temporada_interes) > 0);
    return normalizeListaItem({
      id: ficha.id,
      estado: "pendiente",
      favorita: false,
      puntuacion: null,
      notas: isMob ? "Temporada 2" : "",
      anadido_en: now,
      visto_en: null,
      plataformas: snapshotPlataformasDesdeStreaming(ficha.streaming_es),
      temporada: isMob ? Number(ficha.temporada_interes) || 2 : null,
    });
  }

  return {
    KEY,
    empty,
    load,
    save,
    exportJSON,
    importJSON,
    normalizeListaItem,
    fichaFromSeed,
    fichaFromLegacy,
    listaFromSeedFicha,
  };
})();

/* ---------- State ---------- */
const state = {
  db: Storage.empty(),
  catalogo: [], // fichas de data/catalogo.json (nunca auto-añadidas a la lista)
  filtros: {
    q: "",
    estado: "todos",
    tipo: "todos",
    plataforma: "todas",
    genero: "todos",
    favoritas: false,
    en_cines: false,
    mis_plataformas: false,
    continuar: false,
    orden: "recientes",
  },
  editId: null,
  seedReady: false,
  scoreId: null,
  detalleId: null,
};

function persist() {
  Storage.save(state.db);
}

/* ---------- Sync (Backend) ---------- */
state.auth = { user: null, configured: false, ready: false };

function syncApi() {
  return globalThis.CineSync || null;
}

function fichaParaSync(id) {
  const ficha = state.db.fichas[id];
  if (!ficha) return undefined;
  if (ficha.origen === "usuario" || String(id).startsWith("local:")) {
    // El front nunca escribe streaming_es ni verificado_en a la nube.
    const { streaming_es, verificado_en, ...rest } = ficha;
    void streaming_es;
    void verificado_en;
    return { ...rest, origen: "usuario" };
  }
  return undefined;
}

async function syncPush(cambio) {
  const sync = syncApi();
  if (!sync || !state.auth.user) return;
  try {
    const result = await sync.push(cambio);
    if (result && result.ok === false && !result.skipped) {
      console.warn("sync.push", result.error || result);
    }
  } catch (err) {
    console.warn("sync.push", err);
  }
}

async function syncPrefs() {
  const sync = syncApi();
  if (!sync || !state.auth.user) return;
  try {
    await sync.savePrefs(state.db.misPlataformas || []);
  } catch (err) {
    console.warn("sync.savePrefs", err);
  }
}

function renderAuth() {
  const entrar = document.getElementById("btn-entrar");
  const session = document.getElementById("auth-session");
  const email = document.getElementById("auth-email");
  const note = document.getElementById("lista-persist-note");
  if (!entrar || !session) return;
  if (state.auth.user) {
    entrar.hidden = true;
    session.hidden = false;
    email.textContent = state.auth.user.email || "Sesión iniciada";
    email.title = state.auth.user.email || "";
    if (note) note.textContent = "Con sesión, tu lista se sincroniza entre dispositivos. También queda una copia en este navegador.";
  } else {
    entrar.hidden = false;
    session.hidden = true;
    email.textContent = "";
    if (note) note.textContent = "Tu lista se guarda en este navegador. Con sesión, también se sincroniza entre dispositivos.";
  }
}


function getMerged(id) {
  const row = state.db.lista.find((x) => x.id === id);
  const ficha = state.db.fichas[id] || {};
  if (!row) return null;
  return { ...ficha, ...row, ficha };
}

function contadores() {
  const pendientes = state.db.lista.filter((t) => t.estado === "pendiente").length;
  const vistas = state.db.lista.filter((t) => t.estado === "vista").length;
  const favoritas = state.db.lista.filter((t) => t.favorita).length;
  const sinMarcar = catalogoFueraDeLista().length;
  const total = state.db.lista.length + sinMarcar;
  return {
    total,
    enLista: state.db.lista.length,
    pendientes,
    vistas,
    favoritas,
    sinMarcar,
  };
}

function idsEnListaSet() {
  return new Set(state.db.lista.map((r) => r.id));
}

/** Fichas del catálogo que aún no están en la lista del usuario. */
function catalogoFueraDeLista() {
  const enLista = idsEnListaSet();
  return state.catalogo.filter((f) => f && f.id && !enLista.has(f.id));
}

function asSinMarcar(ficha) {
  return {
    ...ficha,
    plataformas: snapshotPlataformasDesdeStreaming(ficha.streaming_es),
    estado: "sin_marcar",
    favorita: false,
    puntuacion: null,
    notas: "",
    anadido_en: null,
    visto_en: null,
    temporada: null,
    _sinMarcar: true,
  };
}

/** Todas las fichas visibles: lista del usuario + catálogo/custom sin marcar. */
function todosLosTitulos() {
  const marked = state.db.lista.map((row) => getMerged(row.id)).filter(Boolean);
  const enLista = idsEnListaSet();
  const unmarked = catalogoFueraDeLista().map(asSinMarcar);
  const seen = new Set(unmarked.map((t) => t.id));
  for (const [id, ficha] of Object.entries(state.db.fichas || {})) {
    if (enLista.has(id) || seen.has(id)) continue;
    if (esFichaUsuario(ficha) || String(id).startsWith("local:")) {
      unmarked.push(asSinMarcar({ ...ficha, id }));
      seen.add(id);
    }
  }
  return marked.concat(unmarked);
}

function plataformasParaFiltro() {
  const extras = new Set();
  const addPlat = (nombre) => {
    nombre = normalizarNombreSuscripcion(nombre);
    if (!nombre || nombre.toLowerCase() === "cine" || esTiendaAlquilerCompra(nombre)) return;
    if (!PLATAFORMAS_ES.includes(nombre)) extras.add(nombre);
  };
  todosLosTitulos().forEach((t) =>
    (t.plataformas || []).forEach((p) => addPlat(p.nombre))
  );
  const extraList = [...extras].sort((a, b) => a.localeCompare(b, "es"));
  return [...PLATAFORMAS_ES, ...extraList];
}

function generosDisponibles() {
  const set = new Set();
  todosLosTitulos().forEach((t) => (t.generos || []).forEach((g) => set.add(g)));
  return [...set].sort((a, b) => a.localeCompare(b, "es"));
}

function normalizarBusqueda(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Levenshtein acotado, sin dependencias ni cálculo sobre sinopsis largas. */
function distanciaCorta(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(
      current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...current) > max) return false;
    previous = current;
  }
  return previous[b.length] <= max;
}
function coincideTitulo(t, query) {
  const q = normalizarBusqueda(query);
  if (!q) return true;
  return [t.titulo, t.titulo_original].some((title) => {
    const normalized = normalizarBusqueda(title);
    if (normalized.includes(q)) return true;
    const words = normalized.split(" ");
    return q.split(" ").every((word) => words.some((candidate) => {
      if (candidate.startsWith(word)) return true;
      const tolerance = word.length < 4 ? 0 : word.length < 7 ? 1 : 2;
      return tolerance > 0 && (distanciaCorta(word, candidate, tolerance)
        || distanciaCorta(word, candidate.slice(0, word.length), tolerance));
    }));
  });
}
function enMisPlataformas(t) {
  const selected = state.db.misPlataformas || [];
  const subscriptions = t.streaming_es?.length
    ? snapshotPlataformasDesdeStreaming(t.streaming_es) : plataformasCanonicas(t.plataformas);
  return subscriptions.some((p) => selected.includes(PLATAFORMAS_ES.includes(p.nombre) ? p.nombre : "Otra"));
}
function compararRecientes(a, b) {
  return (Number(b.anio) || 0) - (Number(a.anio) || 0)
    || String(b.estreno_es || "").localeCompare(String(a.estreno_es || ""))
    || a.titulo.localeCompare(b.titulo, "es");
}

/* ---------- Seguimiento de series ---------- */
function cleanProgressInt(value, { allowZero = false } = {}) {
  if (value == null || value === "") return null;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) return null;
  if (!allowZero && n < 1) return null;
  return n;
}

function tieneProgreso(row) {
  if (!row) return false;
  return row.temporada != null || row.episodio != null;
}

function formatProgreso(row) {
  if (!tieneProgreso(row)) return "";
  const t = row.temporada != null ? `T${row.temporada}` : "T?";
  const e = row.episodio != null ? `E${row.episodio}` : "E?";
  return `Vas por ${t} · ${e}`;
}

function temporadasConocidas(fichaOrMerged) {
  const t = fichaOrMerged || {};
  const n = Number(t.duracion?.temporadas ?? t.temporadas);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function seriesEnCurso() {
  return state.db.lista
    .map((row) => getMerged(row.id))
    .filter((t) => t && t.tipo === "serie" && t.estado !== "vista" && tieneProgreso(t))
    .sort((a, b) => Date.parse(b.actualizado_en || 0) - Date.parse(a.actualizado_en || 0));
}

/** Asegura fila en lista (pendiente) y escribe progreso. No inventa episodios por temporada. */
function asegurarProgreso(id, patch) {
  let row = state.db.lista.find((x) => x.id === id);
  const ficha =
    state.db.fichas[id] ||
    state.catalogo.find((f) => f.id === id) ||
    null;
  if (!ficha || ficha.tipo !== "serie") {
    toast("El progreso solo aplica a series");
    return null;
  }
  if (!row) {
    state.db.fichas[id] = { ...(state.db.fichas[id] || {}), ...ficha };
    const now = new Date().toISOString();
    row = Storage.normalizeListaItem({
      id,
      estado: "pendiente",
      favorita: false,
      puntuacion: null,
      notas: "",
      anadido_en: now,
      visto_en: null,
      plataformas: snapshotPlataformasDesdeStreaming(ficha.streaming_es),
      temporada: null,
      episodio: null,
    });
    state.db.lista.unshift(row);
    toast("Añadida a pendientes para seguir viendo");
  }
  const nextT = patch.temporada !== undefined
    ? cleanProgressInt(patch.temporada, { allowZero: true })
    : row.temporada;
  const nextE = patch.episodio !== undefined
    ? cleanProgressInt(patch.episodio, { allowZero: true })
    : row.episodio;
  row.temporada = nextT;
  row.episodio = nextE;
  row.actualizado_en = actualizadoAhora(row);
  persist();
  syncPush({ op: "upsert", item: { ...row }, ficha: fichaParaSync(id) });
  return row;
}

function siguienteEpisodio(id) {
  const row = state.db.lista.find((x) => x.id === id);
  const baseT = row?.temporada != null ? row.temporada : 1;
  const baseE = row?.episodio != null ? row.episodio : 0;
  return asegurarProgreso(id, { temporada: baseT, episodio: baseE + 1 });
}

function empezarTemporadaSiguiente(id) {
  const merged = getMergedOrCatalog(id);
  const row = state.db.lista.find((x) => x.id === id);
  const total = temporadasConocidas(merged);
  const current = row?.temporada != null ? row.temporada : cleanProgressInt(merged?.temporada);
  if (total != null && current != null && current >= total) {
    toast(`Ya estás en la última temporada conocida (${total})`);
    return null;
  }
  if (total != null && current != null && current < total) {
    return asegurarProgreso(id, { temporada: current + 1, episodio: 0 });
  }
  // Sin total conocido: no inventamos; pedimos edición manual
  toast("No sé cuántas temporadas tiene. Edita T y E a mano.");
  return null;
}

function progresoPanelHtml(t, sinMarcar) {
  if (t.tipo !== "serie") return "";
  const tVal = !sinMarcar && t.temporada != null ? t.temporada : "";
  const eVal = !sinMarcar && t.episodio != null ? t.episodio : "";
  const total = temporadasConocidas(t);
  const canNextSeason = total != null && t.temporada != null && t.temporada < total;
  return `<div class="detail-section progress-panel" data-progress-id="${escapeHtml(t.id)}">
    <h4>Seguimiento</h4>
    <p class="meta" style="margin:0 0 10px">${tieneProgreso(t) && !sinMarcar ? escapeHtml(formatProgreso(t)) : "Aún no has marcado por dónde vas."}${total ? ` · ${total} temporadas en catálogo` : " · Temporadas totales desconocidas"}</p>
    <div class="progress-edit">
      <label>Temporada <input class="field progress-input" type="number" min="0" inputmode="numeric" data-prog="temporada" value="${tVal}" aria-label="Temporada en curso" /></label>
      <label>Último episodio <input class="field progress-input" type="number" min="0" inputmode="numeric" data-prog="episodio" value="${eVal}" aria-label="Último episodio visto" /></label>
      <button type="button" class="btn btn-primary btn-sm" data-det="prog-guardar" data-id="${escapeHtml(t.id)}">Guardar progreso</button>
    </div>
    <div class="card-actions progress-actions" style="margin-top:10px">
      <button type="button" class="btn" data-det="prog-siguiente" data-id="${escapeHtml(t.id)}">Siguiente episodio</button>
      <button type="button" class="btn" data-det="prog-temp-sig" data-id="${escapeHtml(t.id)}" ${canNextSeason ? "" : "disabled"} title="${canNextSeason ? "Pasa a la siguiente temporada (episodio 0)" : "Solo si el catálogo indica más temporadas"}">Empezar temporada siguiente</button>
    </div>
    <p class="meta" style="margin:8px 0 0">No inventamos episodios por temporada. Si falta el total, edita a mano.</p>
  </div>`;
}

/* ---------- Qué veo hoy ---------- */
const ANIMO_A_GENEROS = {
  cualquiera: [],
  drama: ["Drama"],
  comedia: ["Comedia"],
  accion: ["Acción", "Action & Adventure", "Aventura", "Thriller"],
  terror: ["Terror", "Suspense", "Misterio", "Horror"],
  scifi: ["Ciencia ficción", "Sci-Fi & Fantasy", "Fantasía"],
  romantico: ["Romance"],
  documental: ["Documental"],
};

const TIEMPO_PRESETS = {
  corto: { id: "corto", label: "<45 min", max: 45, min: 0 },
  medio: { id: "medio", label: "~1 h 30", max: 120, min: 70 },
  largo: { id: "largo", label: "2 h+", max: Infinity, min: 120 },
  libre: { id: "libre", label: "Sin límite", max: Infinity, min: 0 },
};

function minutosDeTitulo(t) {
  const d = t?.duracion;
  if (t?.tipo === "serie") {
    const ep = Number(d?.minutos_episodio);
    return Number.isFinite(ep) && ep > 0 ? ep : null;
  }
  const mins = typeof d === "object" && d ? Number(d.minutos) : Number(d);
  return Number.isFinite(mins) && mins > 0 ? mins : null;
}

function formatMinutosHumanos(mins) {
  if (mins == null) return null;
  const h = Math.floor(mins / 60), r = mins % 60;
  if (h && r) return `${h} h ${r} min`;
  if (h) return `${h} h`;
  return `${mins} min`;
}

/** Disponibilidad verificada en suscripciones que el usuario tiene contratadas. */
function disponibilidadVerificadaEnMis(t) {
  const selected = state.db.misPlataformas || [];
  const hits = [];
  const pending = [];
  for (const s of t.streaming_es || []) {
    if (s.tipo !== "subscription" || esTiendaAlquilerCompra(s.plataforma)) continue;
    const nombre = normalizarNombreSuscripcion(s.plataforma);
    if (!nombre) continue;
    const canon = PLATAFORMAS_ES.includes(nombre) ? nombre : "Otra";
    const verificado = String(s.estado || "").toLowerCase() === "verificado";
    if (!selected.length) {
      if (verificado) hits.push(nombre);
      else pending.push(nombre);
      continue;
    }
    if (!selected.includes(canon)) continue;
    if (verificado) hits.push(nombre);
    else pending.push(nombre);
  }
  return {
    verified: [...new Set(hits)],
    pending: [...new Set(pending)],
    sinPlataformas: !selected.length,
  };
}

function generosFavoritosDeHistorial() {
  const scores = new Map();
  for (const row of state.db.lista) {
    if (row.estado !== "vista" || row.puntuacion == null || row.puntuacion < 7) continue;
    const ficha = state.db.fichas[row.id] || {};
    for (const g of ficha.generos || []) {
      scores.set(g, (scores.get(g) || 0) + row.puntuacion);
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
}

function cabeEnTiempo(mins, preset, { estricto = false } = {}) {
  if (preset.id === "libre") return true;
  if (mins == null) return !estricto; // desconocida: no excluir salvo estricto
  if (preset.id === "corto") return mins < 45;
  if (preset.id === "medio") return mins >= 70 && mins <= 120;
  if (preset.id === "largo") return mins >= 120;
  return true;
}

let queVeoShuffle = 0;

function sugerirQueVeoHoy(prefs) {
  const preset = TIEMPO_PRESETS[prefs.tiempo] || TIEMPO_PRESETS.libre;
  const tipo = prefs.tipo || "ambas";
  const animo = prefs.animo || "cualquiera";
  const generosAnimo = ANIMO_A_GENEROS[animo] || [];
  const historialGeneros = generosFavoritosDeHistorial();
  const tieneHistorial = historialGeneros.length > 0;
  const misPlataformas = state.db.misPlataformas || [];
  const candidatos = [];

  for (const t of todosLosTitulos()) {
    if (t._sinMarcar) continue;
    if (t.estado === "vista") continue; // nunca vistas; en curso = pendiente con progreso
    if (tipo === "pelicula" && t.tipo !== "pelicula") continue;
    if (tipo === "serie" && t.tipo !== "serie") continue;
    if (generosAnimo.length && !(t.generos || []).some((g) => generosAnimo.includes(g))) continue;

    const mins = minutosDeTitulo(t);
    if (!cabeEnTiempo(mins, preset, { estricto: false })) continue;

    const avail = disponibilidadVerificadaEnMis(t);
    let score = 0;
    const reasons = [];

    const enCurso = t.tipo === "serie" && tieneProgreso(t) && t.estado !== "vista";
    if (enCurso) {
      score += 100;
      reasons.push(`Tienes en curso ${formatProgreso(t).replace(/^Vas por /, "")}`);
    }
    if (t.estado === "pendiente" && !enCurso) {
      score += 40;
      reasons.push("La tienes pendiente");
    }
    if (t.favorita) {
      score += 35;
      reasons.push("La marcaste como favorita");
    }
    if (tieneHistorial) {
      const match = (t.generos || []).filter((g) => historialGeneros.slice(0, 5).includes(g));
      if (match.length) {
        score += 25 * match.length;
        reasons.push(`Coincide con ${match[0]}, tu género más puntuado`);
      }
    } else if (generosAnimo.length) {
      const match = (t.generos || []).filter((g) => generosAnimo.includes(g));
      if (match.length) {
        score += 20;
        reasons.push(`Coincide con ${match[0]}, que has elegido`);
      }
    }
    if (misPlataformas.length) {
      if (avail.verified.length) {
        score += 30;
        reasons.push(`Está en ${avail.verified[0]}, que tienes`);
      } else if (avail.pending.length) {
        score += 5;
        reasons.push(`Disponibilidad por verificar en ${avail.pending[0]}`);
      }
    }
    if (mins != null) {
      if (cabeEnTiempo(mins, preset, { estricto: true })) score += 10;
      reasons.push(`Dura ${formatMinutosHumanos(mins)}${t.tipo === "serie" ? "/ep" : ""}`);
    } else {
      reasons.push("Duración desconocida");
    }

    candidatos.push({ t, score, reasons, mins, avail });
  }

  candidatos.sort((a, b) => b.score - a.score
    || Date.parse(b.t.actualizado_en || 0) - Date.parse(a.t.actualizado_en || 0)
    || a.t.titulo.localeCompare(b.t.titulo, "es"));

  // Agrupar por score y rotar el primer grupo con «Otras ideas»
  if (candidatos.length && queVeoShuffle > 0) {
    const top = candidatos[0].score;
    let i = 0;
    while (i < candidatos.length && candidatos[i].score === top) i += 1;
    const group = candidatos.slice(0, i);
    const rest = candidatos.slice(i);
    const rot = queVeoShuffle % group.length;
    candidatos.splice(0, candidatos.length, ...group.slice(rot), ...group.slice(0, rot), ...rest);
  }

  const picks = candidatos.slice(0, 5);
  return {
    picks,
    meta: {
      tieneHistorial,
      sinPlataformas: !misPlataformas.length,
      criterio: [
        "Priorizo series en curso, luego pendientes y favoritas.",
        tieneHistorial
          ? "Uso los géneros de tus vistas con nota alta (≥7)."
          : "Aún no tengo historial, me baso en lo que has elegido.",
        misPlataformas.length
          ? "Solo cuento suscripción verificada en tus plataformas."
          : "No has marcado plataformas: no filtro por disponibilidad.",
        "La duración sale solo de la ficha; si falta, lo digo y no te excluyo.",
      ],
      preset,
      animo,
      tipo,
    },
  };
}

function filtrarYOrdenar() {
  const f = state.filtros;
  const list = todosLosTitulos().filter((t) => {
    if (f.estado === "sin_marcar") {
      if (!t._sinMarcar) return false;
    } else if (f.estado !== "todos" && (t._sinMarcar || t.estado !== f.estado)) return false;
    if (f.tipo !== "todos" && t.tipo !== f.tipo) return false;
    if (f.favoritas && (t._sinMarcar || !t.favorita)) return false;
    if (f.en_cines && !t.en_cines) return false;
    if (f.mis_plataformas && !enMisPlataformas(t)) return false;
    if (f.continuar) {
      if (t._sinMarcar || t.tipo !== "serie" || t.estado === "vista" || !tieneProgreso(t)) return false;
    }
    if (f.plataforma !== "todas" && !(t.plataformas || []).some((p) => plataformaCoincideFiltro(p.nombre, f.plataforma))) return false;
    if (f.genero !== "todos" && !(t.generos || []).includes(f.genero)) return false;
    return coincideTitulo(t, f.q);
  });
  const cmp = {
    recientes: compararRecientes,
    titulo_asc: (a, b) => a.titulo.localeCompare(b.titulo, "es"),
    cines_primero: (a, b) => Number(Boolean(b.en_cines)) - Number(Boolean(a.en_cines)) || compararRecientes(a, b),
    puntuacion_desc: (a, b) => (b.puntuacion ?? -1) - (a.puntuacion ?? -1) || compararRecientes(a, b),
  };
  return list.sort(cmp[normalizarOrden(f.orden)]);
}

/* ---------- Seed ---------- */
async function loadSeedArray() {
  try {
    const res = await fetch("data/seed.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("seed no es array");
    return data;
  } catch (err) {
    if (Array.isArray(window.CINE_SEED)) return window.CINE_SEED;
    throw err;
  }
}

async function loadCatalogoArray() {
  try {
    const res = await fetch("data/catalogo.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("catalogo no es array");
    return data;
  } catch (err) {
    if (Array.isArray(window.CINE_CATALOGO)) return window.CINE_CATALOGO;
    return [];
  }
}

function aplicarCatalogoUnion(seedArr, catalogArr) {
  const byId = new Map();
  for (const raw of [...(seedArr || []), ...(catalogArr || [])]) {
    const ficha = Storage.fichaFromSeed(raw);
    if (!ficha.id) continue;
    byId.set(ficha.id, ficha);
  }
  state.catalogo = [...byId.values()];
}

function fichaDesdeCatalogo(id) {
  return state.catalogo.find((f) => f.id === id) || state.db.fichas[id] || null;
}

/** Notas por defecto del seed antiguo (auto-alta sin tocar). */
function notasDefaultSeed(id) {
  if (id === MOBLAND_ID) return new Set(["", "Temporada 2"]);
  return new Set([""]);
}

/** Estado inicial: catálogo completo Sin marcar, sin altas automáticas en lista. */
function aplicarEstadoFresco() {
  const seedIds = state.catalogo.map((f) => f.id);
  state.db = {
    fichas: Object.fromEntries(state.catalogo.map((ficha) => [ficha.id, { ...ficha }])),
    lista: [],
    // Marcar el catálogo semilla como ya «ofrecido» para no auto-añadir nada
    seedIds,
    migracion: MIGRACION_SIN_MARCAR,
    misPlataformas: normalizarMisPlataformas(state.db.misPlataformas),
    orden: normalizarOrden(state.db.orden || state.filtros.orden),
  };
  persist();
}

/**
 * Quita altas automáticas del seed que el usuario no tocó
 * (pendiente, sin favorita/puntuación/visto, notas vacías o default tipo «Temporada 2»).
 */
function migrarSinMarcar1(seedArr) {
  const seedIdSet = new Set((seedArr || []).map((r) => String(r.id)));
  const kept = [];
  for (const row of state.db.lista) {
    const id = String(row.id);
    if (!seedIdSet.has(id)) {
      kept.push(row); // alta manual / catálogo
      continue;
    }
    const notas = String(row.notas || "").trim();
    const untouched =
      row.estado === "pendiente" &&
      !row.favorita &&
      row.puntuacion == null &&
      !row.visto_en &&
      notasDefaultSeed(id).has(notas);
    if (untouched) continue;
    kept.push(row);
  }
  state.db.lista = kept;

  const offered = new Set(
    (Array.isArray(state.db.seedIds) ? state.db.seedIds : []).map(String)
  );
  for (const id of seedIdSet) offered.add(id);
  state.db.seedIds = [...offered];
}

/** Refresca ficha + snapshot de plataformas para ids ya en lista (sin tocar campos personales). */
function syncFichasListaDesdeCatalogo() {
  if (!state.db.fichas) state.db.fichas = {};
  // Incorporar nuevas fichas al catálogo guardado, nunca a la lista personal.
  // Actualizar extras de fichas existentes sin sobrescribir otros datos manuales.
  for (const ficha of state.catalogo) {
    if (!state.db.fichas[ficha.id]) state.db.fichas[ficha.id] = { ...ficha };
    else Object.assign(state.db.fichas[ficha.id], {
      backdrop: ficha.backdrop, duracion: ficha.duracion, extras_info: ficha.extras_info,
    });
  }
  for (const row of state.db.lista) {
    const ficha = fichaDesdeCatalogo(row.id);
    if (!ficha) continue;
    state.db.fichas[row.id] = { ...(state.db.fichas[row.id] || {}), ...ficha };
    row.plataformas = snapshotPlataformasDesdeStreaming(ficha.streaming_es);
  }
}

async function ensureData() {
  const seed = await loadSeedArray();
  const catalogExtra = await loadCatalogoArray();
  aplicarCatalogoUnion(seed, catalogExtra);

  const loaded = Storage.load();
  if (loaded) {
    state.db = {
      fichas: loaded.fichas || {},
      lista: Array.isArray(loaded.lista) ? loaded.lista : [],
      seedIds: loaded.seedIds,
      migracion: loaded.migracion || null,
      misPlataformas: loaded.misPlataformas,
      orden: loaded.orden,
    };
    if (state.db.migracion !== MIGRACION_SIN_MARCAR) {
      migrarSinMarcar1(seed);
      state.db.migracion = MIGRACION_SIN_MARCAR;
    }
    if (!Array.isArray(state.db.seedIds)) {
      state.db.seedIds = (seed || []).map((r) => String(r.id));
    }
    syncFichasListaDesdeCatalogo();
    persist();
  } else {
    aplicarEstadoFresco();
  }
  state.filtros.orden = normalizarOrden(state.db.orden);
  state.seedReady = true;
}

/* ---------- CRUD lista ---------- */
function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

function addOrUpdateFromForm(data) {
  const id = data.id || uid();
  const existing = state.db.lista.find((x) => x.id === id);
  if (existing && !state.editId) {
    toast("Ya estaba en tu lista");
    return existing;
  }
  if (existing && state.editId && state.editId !== id) {
    // shouldn't happen
  }

  const ficha = {
    ...(state.db.fichas[id] || {}),
    id,
    tipo: data.tipo,
    titulo: data.titulo,
    titulo_original: data.titulo_original || state.db.fichas[id]?.titulo_original || "",
    anio: data.anio,
    generos: data.generos,
    sinopsis: data.sinopsis,
    poster: data.poster,
    trailer: state.db.fichas[id]?.trailer || "",
    streaming_es: state.db.fichas[id]?.streaming_es || [],
    duracion: state.db.fichas[id]?.duracion && typeof state.db.fichas[id].duracion === "object"
      ? { ...state.db.fichas[id].duracion,
          ...(data.tipo === "serie" ? { temporadas: data.temporadas } : { minutos: data.duracion }) }
      : data.duracion,
    temporadas: data.temporadas,
    temporada_interes: state.db.fichas[id]?.temporada_interes ?? null,
    nota: state.db.fichas[id]?.nota || "",
    fuentes: state.db.fichas[id]?.fuentes || [],
    verificado_en: state.db.fichas[id]?.verificado_en || null,
    en_cines: Boolean(state.db.fichas[id]?.en_cines),
    estreno_es: state.db.fichas[id]?.estreno_es || null,
    popularidad_fuente: state.db.fichas[id]?.popularidad_fuente || "",
  };
  state.db.fichas[id] = ficha;

  const row = Storage.normalizeListaItem({
    id,
    estado: data.estado === "vista" ? "vista" : "pendiente",
    favorita: Boolean(data.favorita),
    puntuacion: data.puntuacion,
    notas: data.notas,
    anadido_en: existing?.anadido_en || new Date().toISOString(),
    actualizado_en: actualizadoAhora(existing),
    visto_en:
      data.estado === "vista"
        ? existing?.visto_en || new Date().toISOString()
        : null,
    plataformas: data.plataformas,
    temporada: data.temporada,
  });

  if (existing) {
    const idx = state.db.lista.findIndex((x) => x.id === id);
    state.db.lista[idx] = row;
  } else {
    state.db.lista.unshift(row);
  }
  // Altas manuales nuevas: marcar origen usuario sin tocar streaming_es/verificado_en
  if (!existing && (String(id).startsWith("local:") || !state.catalogo.some((f) => f.id === id))) {
    state.db.fichas[id] = { ...ficha, origen: ficha.origen || "usuario", streaming_es: Array.isArray(ficha.streaming_es) ? ficha.streaming_es : [] };
  }
  persist();
  syncPush({ op: "upsert", item: row, ficha: fichaParaSync(id) });
  if (row.estado === "vista" && existing?.estado !== "vista") mostrarPuntuacion(id);
  else if (row.estado !== "vista" && state.scoreId === id) cerrarPuntuacion();
  return row;
}

/** Intentar añadir ficha de catálogo a lista (por id). */
function addFichaToLista(id) {
  if (state.db.lista.some((x) => x.id === id)) {
    toast("Ya estaba en tu lista");
    return false;
  }
  const ficha = state.db.fichas[id];
  if (!ficha) return false;
  const row = Storage.listaFromSeedFicha(ficha);
  state.db.lista.unshift(row);
  persist();
  syncPush({ op: "upsert", item: row, ficha: fichaParaSync(id) });
  return true;
}

/**
 * Añade una ficha de Explorar a la lista con el estado elegido.
 * No toca otras entradas. favorita/puntuacion/notas vacíos; temporada según ficha.
 */
function addFromExplorar(id, estado, opciones = {}) {
  if (state.db.lista.some((x) => x.id === id)) {
    toast("Ya estaba en tu lista");
    return false;
  }
  const ficha =
    state.catalogo.find((f) => f.id === id) ||
    state.db.fichas[id] ||
    null;
  if (!ficha) return false;

  state.db.fichas[id] = { ...(state.db.fichas[id] || {}), ...ficha };

  const now = new Date().toISOString();
  const esVista = estado === "vista";
  const isMob =
    ficha.id === "tmdb:247718" ||
    (ficha.temporada_interes != null && Number(ficha.temporada_interes) > 0);
  const row = Storage.normalizeListaItem({
    id: ficha.id,
    estado: esVista ? "vista" : "pendiente",
    favorita: Boolean(opciones.favorita),
    puntuacion: null,
    notas: "",
    anadido_en: now,
    visto_en: esVista ? now : null,
    plataformas: snapshotPlataformasDesdeStreaming(ficha.streaming_es),
    temporada: isMob ? Number(ficha.temporada_interes) || 2 : null,
  });
  state.db.lista.unshift(row);
  persist();
  syncPush({ op: "upsert", item: row, ficha: fichaParaSync(id) });
  toast(opciones.favorita ? "Añadida a pendientes y favoritas" : esVista ? "Añadida como vista" : "Añadida a pendientes");
  if (esVista) mostrarPuntuacion(id);
  return true;
}

function getFichaExplorar(id) {
  return state.catalogo.find((f) => f.id === id) || null;
}

function getMergedOrCatalog(id) {
  const merged = getMerged(id);
  if (merged) return merged;
  const ficha = getFichaExplorar(id);
  if (!ficha) return null;
  return asSinMarcar(ficha);
}

function borrarDeLista(id) {
  const existing = state.db.lista.find((t) => t.id === id);
  const when = existing ? actualizadoAhora(existing) : new Date().toISOString();
  if (state.scoreId === id) cerrarPuntuacion();
  state.db.lista = state.db.lista.filter((t) => t.id !== id);
  persist();
  syncPush({ op: "borrar", id, actualizado_en: when });
}

function toggleEstado(id) {
  const t = state.db.lista.find((x) => x.id === id);
  if (!t) return;
  if (t.estado === "vista") {
    t.estado = "pendiente";
    t.visto_en = null;
    if (state.scoreId === id) cerrarPuntuacion();
  } else {
    t.estado = "vista";
    t.visto_en = new Date().toISOString();
    mostrarPuntuacion(id);
  }
  t.actualizado_en = actualizadoAhora(t);
  persist();
  syncPush({ op: "upsert", item: t, ficha: fichaParaSync(id) });
}

function toggleFavorita(id) {
  const t = state.db.lista.find((x) => x.id === id);
  if (!t) return addFromExplorar(id, "pendiente", { favorita: true });
  t.favorita = !t.favorita;
  t.actualizado_en = actualizadoAhora(t);
  persist();
  syncPush({ op: "upsert", item: t, ficha: fichaParaSync(id) });
}

function mostrarPuntuacion(id) {
  const t = getMerged(id);
  if (!t || t.estado !== "vista") return;
  state.scoreId = id;
  $("#score-name").textContent = t.titulo;
  $("#score-values").innerHTML = Array.from({ length: 10 }, (_, i) => `<button type="button" class="btn" data-score="${i + 1}" aria-label="Puntuar ${escapeHtml(t.titulo)} con ${i + 1} sobre 10" aria-pressed="${t.puntuacion === i + 1}">${i + 1}</button>`).join("");
  $("#score-prompt").hidden = false;
  colocarPuntuacion();
  $("#score-announcement").textContent = `Marcada como vista: ${t.titulo}. Puedes puntuar de 1 a 10 u omitir la puntuación.`;
}
function colocarPuntuacion() {
  const parent = $(".modal-backdrop.open .modal") || document.body;
  parent.appendChild($("#score-prompt"));
}
function cerrarPuntuacion() {
  const prompt = $("#score-prompt");
  const restore = prompt.contains(document.activeElement);
  const id = state.scoreId;
  prompt.hidden = true;
  state.scoreId = null;
  if (restore) {
    const modal = $(".modal-backdrop.open");
    const target = modal ? modal.querySelector("[data-close]")
      : $$(".card").find((card) => card.dataset.id === id)?.querySelector('[data-action="estado-vista"]');
    target?.focus({ preventScroll: true });
  }
}
function guardarPuntuacion(value) {
  const row = state.db.lista.find((t) => t.id === state.scoreId);
  if (!row || row.estado !== "vista" || !Number.isInteger(value) || value < 1 || value > 10) return;
  row.puntuacion = value;
  row.actualizado_en = actualizadoAhora(row);
  persist();
  syncPush({ op: "upsert", item: row, ficha: fichaParaSync(row.id) });
  cerrarPuntuacion();
  renderAll();
  if ($("#modal-detalle").classList.contains("open") && state.detalleId === row.id) openDetalle(getMerged(row.id));
  toast(`Puntuación guardada: ${value}/10`);
}
function abrirMisPlataformas() {
  $("#platform-choices").innerHTML = [...PLATAFORMAS_ES, "Otra"].map((p) => `<label class="platform-choice"><input type="checkbox" name="mis-plataformas" value="${escapeHtml(p)}" ${(state.db.misPlataformas || []).includes(p) ? "checked" : ""} /><span>${escapeHtml(p)}</span></label>`).join("");
  openModal("#modal-plataformas");
}

/* ---------- DOM ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatFecha(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("es-ES", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

/** Fecha solo día (YYYY-MM-DD) en locale es-ES, sin desfase UTC. */
function formatFechaDia(ymd) {
  if (!ymd) return null;
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return formatFecha(ymd);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString("es-ES", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function labelEstado(e) {
  if (e === "vista") return "Vista";
  if (e === "sin_marcar") return "Sin marcar";
  return "Pendiente";
}

function posterHtml(t) {
  if (t.poster) {
    return `<img src="${escapeHtml(t.poster)}" alt="Póster de ${escapeHtml(t.titulo)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'poster-fallback',textContent:'Sin póster'}))" />`;
  }
  return `<div class="poster-fallback">Sin póster</div>`;
}

function plataformasHtml(plataformas, opts = {}) {
  if (plataformas?.length) {
    return plataformas
      .map((p) => {
        const warn = p.verificacion !== "verificado";
        const label = warn ? `${escapeHtml(p.nombre)} · Por verificar` : escapeHtml(p.nombre);
        return `<span class="chip ${warn ? "chip-warn" : "chip-ok"}">${label}</span>`;
      })
      .join("");
  }
  if (opts.porVerificar) return `<span class="chip chip-pending">Plataformas por verificar</span>`;
  return `<span class="chip">Sin suscripción detectada</span>`;
}

function esFichaUsuario(fichaOrId) {
  if (!fichaOrId) return false;
  if (typeof fichaOrId === "string") {
    const f = state.db.fichas[fichaOrId];
    return Boolean(f && (f.origen === "usuario" || String(fichaOrId).startsWith("local:")));
  }
  return fichaOrId.origen === "usuario" || String(fichaOrId.id || "").startsWith("local:");
}

function renderStats() {
  const c = contadores();
  $("#stats").innerHTML = `<div class="stat"><strong>${c.total}</strong> títulos · <strong>${c.enLista}</strong> en tu lista</div>`;
  $("#collection-counters").innerHTML = `
    <div class="counter"><strong>${c.sinMarcar}</strong>Sin marcar</div>
    <div class="counter counter-pendiente"><strong>${c.pendientes}</strong>Pendientes</div>
    <div class="counter counter-vista"><strong>${c.vistas}</strong>Vistas</div>
    <div class="counter counter-favorita"><strong>${c.favoritas}</strong>★ favoritas</div>`;
}

function renderHero() {
  const art = $("#intro-art");
  if (art.children.length) return;
  const posters = state.catalogo.filter((t) => t.poster).slice(0, 3);
  art.innerHTML = posters.map((t) => `<div class="hero-poster"><img src="${escapeHtml(t.poster)}" alt="" onerror="this.style.visibility='hidden'" /></div>`).join("");
}

function renderFilterState(count) {
  const f = state.filtros;
  const active = f.q || f.estado !== "todos" || f.tipo !== "todos" || f.plataforma !== "todas" || f.genero !== "todos" || f.favoritas || f.en_cines || f.mis_plataformas || f.continuar;
  $("#resultados").innerHTML = `<strong>${count}</strong> ${count === 1 ? "título" : "títulos"}${active ? " encontrados" : " para descubrir"}`;
  $("#btn-limpiar").hidden = !active;
  const all = todosLosTitulos();
  $("#count-en-cines").textContent = all.filter((t) => t.en_cines).length;
  $("#count-favoritas").textContent = all.filter((t) => t.favorita).length;
  $("#count-mis-plataformas").textContent = all.filter(enMisPlataformas).length;
  const countCont = $("#count-continuar");
  if (countCont) countCont.textContent = String(seriesEnCurso().length);
  $("#mis-plataformas-total").textContent = (state.db.misPlataformas || []).length;
  $("#filtro-mis-plataformas").checked = f.mis_plataformas;
  const contEl = $("#filtro-continuar");
  if (contEl) contEl.checked = f.continuar;
  ["estado", "tipo", "plataforma", "genero"].forEach((key) => {
    const select = $("#filtro-" + key);
    select.closest(".filter-control").classList.toggle("is-active", select.value !== (key === "plataforma" ? "todas" : "todos"));
  });
}

function renderFiltrosOpciones() {
  $("#filtro-orden").value = state.filtros.orden;
  const platSel = $("#filtro-plataforma");
  const genSel = $("#filtro-genero");
  const plats = plataformasParaFiltro();
  const gen = generosDisponibles();
  const curP = state.filtros.plataforma;
  const curG = state.filtros.genero;
  platSel.innerHTML =
    `<option value="todas">Todas las plataformas</option>` +
    plats.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  genSel.innerHTML =
    `<option value="todos">Todos los géneros</option>` +
    gen.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
  platSel.value = plats.includes(curP) || curP === "todas" ? curP : "todas";
  if (![...platSel.options].some((o) => o.value === platSel.value)) platSel.value = "todas";
  genSel.value = gen.includes(curG) ? curG : "todos";
  state.filtros.plataforma = platSel.value;
  state.filtros.genero = genSel.value;
  $("#filtro-favoritas").checked = state.filtros.favoritas;
  const enCinesEl = $("#filtro-en-cines");
  if (enCinesEl) enCinesEl.checked = state.filtros.en_cines;
  const contFiltro = $("#filtro-continuar");
  if (contFiltro) contFiltro.checked = state.filtros.continuar;
}

function renderGrid() {
  const list = filtrarYOrdenar();
  const grid = $("#grid");
  // Mantener el foco de una acción rápida después de refrescar las tarjetas.
  const focused = document.activeElement?.closest(".card");
  const focusId = focused?.dataset.id;
  const focusAction = focused ? document.activeElement.dataset.action : null;
  renderFilterState(list.length);
  if (!list.length) {
    grid.innerHTML = `<div class="empty"><strong>Ningún título por aquí… todavía.</strong>${state.filtros.mis_plataformas && !state.db.misPlataformas.length ? 'Elige tus suscripciones para descubrir qué puedes ver. <button type="button" class="btn" data-open-platforms>Elegir mis plataformas</button>' : 'No hay títulos con estos filtros. Prueba otra búsqueda o pulsa «Limpiar filtros».'}</div>`;
    return;
  }
  grid.innerHTML = list.map((t) => {
    const sinMarcar = Boolean(t._sinMarcar);
    const title = escapeHtml(t.titulo);
    const progressLine = !sinMarcar && t.tipo === "serie" && tieneProgreso(t) ? formatProgreso(t) : "";
    const metaBits = [t.anio || "Año por verificar", t.tipo === "serie" ? "Serie" : "Película",
      !sinMarcar && t.puntuacion != null ? `★ ${t.puntuacion}/10` : null].filter(Boolean).join(" · ");
    const platforms = plataformasCanonicas(t.plataformas);
    const porVerificar = esFichaUsuario(t) && !(t.streaming_es || []).length && !platforms.length;
    const extraPlatforms = platforms.length > 2 ? `<span class="chip">+${platforms.length - 2} en ficha</span>` : "";
    return `
      <article class="card" data-id="${escapeHtml(t.id)}" data-mode="${sinMarcar ? "sin-marcar" : "lista"}" aria-label="${title}">
        <div class="poster">
          <button type="button" class="poster-open" data-action="detalle" aria-label="Ver ficha de ${title}">
            ${posterHtml(t)}<span class="poster-hint">Ver ficha ↗</span>
          </button>
          <div class="badge-row">
            <span class="badge badge-${sinMarcar ? "sin-marcar" : t.estado}">${escapeHtml(labelEstado(t.estado))}</span>
            ${t.en_cines ? `<span class="badge badge-en-cines" title="${t.estreno_es ? 'Estreno ES: ' + escapeHtml(formatFechaDia(t.estreno_es)) : 'En cines'}">▣ En cines</span>` : ""}
          </div>
          <button type="button" class="fav-btn ${t.favorita ? "on" : ""}" data-action="fav" aria-pressed="${t.favorita}" aria-label="${sinMarcar ? 'Añadir a pendientes y favoritas: ' : t.favorita ? 'Quitar de favoritas: ' : 'Añadir a favoritas: '}${title}" title="${sinMarcar ? 'Añadir a pendientes y favoritas' : t.favorita ? 'Quitar de favoritas' : 'Añadir a favoritas'}">★</button>
        </div>
        <div class="card-body">
          <h3 class="card-title"><button class="title-button" type="button" data-action="detalle">${title}</button></h3>
          <div class="meta">${escapeHtml(metaBits)}</div>
          ${progressLine ? `<div class="meta card-progress" aria-label="Progreso">${escapeHtml(progressLine)}</div>` : ""}
          <div class="chips genres">${(t.generos || []).slice(0, 2).map((g) => `<span class="chip">${escapeHtml(g)}</span>`).join("")}</div>
          <div class="chips platforms">${plataformasHtml(platforms.slice(0, 2), { porVerificar })}${extraPlatforms}</div>
          <div class="card-actions quick-actions">
            <button type="button" class="btn ${!sinMarcar && t.estado === "pendiente" ? "is-selected" : ""}" data-action="estado-pendiente" aria-label="Marcar pendiente: ${title}" aria-pressed="${!sinMarcar && t.estado === "pendiente"}">＋ Pendiente</button>
            <button type="button" class="btn ${!sinMarcar && t.estado === "vista" ? "is-selected is-vista" : ""}" data-action="estado-vista" aria-label="Marcar vista: ${title}" aria-pressed="${!sinMarcar && t.estado === "vista"}">✓ Vista</button>
          </div>
        </div>
      </article>`;
  }).join("");
  if (focusId && focusAction) {
    const card = $$(".card", grid).find((el) => el.dataset.id === focusId);
    card?.querySelector(`[data-action="${focusAction}"]`)?.focus({ preventScroll: true });
  }
}

function renderContinuar() {
  const el = $("#continuar-viendo");
  if (!el) return;
  if (state.filtros.continuar) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const list = seriesEnCurso().slice(0, 8);
  const countEl = $("#count-continuar");
  if (countEl) countEl.textContent = String(seriesEnCurso().length);
  if (!list.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = `<div class="continuar-head"><div><p class="eyebrow">SIGUE DONDE LO DEJASTE</p><h3>Continuar viendo</h3></div>
    <button type="button" class="btn btn-ghost btn-sm" id="btn-ver-continuar">Ver todas (${list.length})</button></div>
    <div class="continuar-rail">${list.map((t) => {
      const title = escapeHtml(t.titulo);
      return `<button type="button" class="continuar-card" data-continuar-id="${escapeHtml(t.id)}" aria-label="Continuar ${title}: ${escapeHtml(formatProgreso(t))}">
        <span class="continuar-poster">${t.poster ? `<img src="${escapeHtml(t.poster)}" alt="" />` : `<span class="poster-fallback">sin póster</span>`}</span>
        <span class="continuar-copy"><strong>${title}</strong><span class="meta">${escapeHtml(formatProgreso(t))}</span></span>
      </button>`;
    }).join("")}</div>`;
}

function renderAll() {
  renderAuth();
  renderHero();
  renderStats();
  renderFiltrosOpciones();
  renderContinuar();
  renderGrid();
}

let searchTimer;
const modalFocus = new Map();
function openModal(id) {
  $$(".modal-backdrop.open").forEach((open) => { if (open !== $(id)) closeModal("#" + open.id); });
  const modal = $(id);
  if (!modal.classList.contains("open")) modalFocus.set(id, document.activeElement);
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  $(".app").inert = true;
  document.body.style.overflow = "hidden";
  if (!$("#score-prompt").hidden) colocarPuntuacion();
  modal.querySelector("button, input, select, textarea, a[href]")?.focus({ preventScroll: true });
}
function closeModal(id) {
  const modal = $(id);
  if (!modal.classList.contains("open")) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  colocarPuntuacion();
  if (!$(".modal-backdrop.open")) {
    $(".app").inert = false;
    document.body.style.overflow = "";
    const previous = modalFocus.get(id);
    if (previous?.isConnected && previous.getClientRects().length) previous.focus({ preventScroll: true });
    else if (previous?.closest(".library-menu")) $(".library-toggle").focus({ preventScroll: true });
    else $("#busqueda").focus({ preventScroll: true });
  }
}

function platformOptionsHtml(selected) {
  const isKnown =
    PLATAFORMAS_ES.includes(selected) || selected === "" || selected == null;
  const opts =
    PLATAFORMAS_ES.map(
      (p) =>
        `<option value="${escapeHtml(p)}"${selected === p ? " selected" : ""}>${escapeHtml(p)}</option>`
    ).join("") +
    `<option value="__otra__"${!isKnown && selected ? " selected" : ""}>Otra…</option>`;
  return opts;
}

function setPlatformRows(plataformas) {
  const box = $("#platform-editor");
  box.innerHTML = "";
  const list =
    plataformas && plataformas.length
      ? plataformas
      : [{ nombre: "Netflix", verificacion: "por verificar" }];
  list.forEach((p) => box.appendChild(platformRowEl(p)));
}

function platformRowEl(p = { nombre: "", verificacion: "por verificar" }) {
  const row = document.createElement("div");
  row.className = "platform-row";
  const known = PLATAFORMAS_ES.includes(p.nombre);
  const otra = p.nombre && !known;
  row.innerHTML = `
    <select class="select plat-sel" aria-label="Plataforma de suscripción">${platformOptionsHtml(otra ? null : p.nombre || "Netflix")}</select>
    <input class="field plat-otra" aria-label="Nombre de otra plataforma" placeholder="Nombre de la plataforma" ${otra ? "" : "hidden"} value="${otra ? escapeHtml(p.nombre) : ""}" />
    <select class="select plat-verif" aria-label="Verificación de la plataforma">
      <option value="por verificar"${p.verificacion !== "verificado" ? " selected" : ""}>Por verificar</option>
      <option value="verificado"${p.verificacion === "verificado" ? " selected" : ""}>Verificado</option>
    </select>
    <button type="button" class="btn btn-sm btn-danger plat-remove" aria-label="Quitar plataforma" title="Quitar plataforma">✕</button>
  `;
  const sel = row.querySelector(".plat-sel");
  const otraInput = row.querySelector(".plat-otra");
  if (otra) sel.value = "__otra__";
  sel.addEventListener("change", () => {
    const isOtra = sel.value === "__otra__";
    otraInput.hidden = !isOtra;
    if (isOtra) otraInput.focus();
  });
  row.querySelector(".plat-remove").addEventListener("click", () => {
    row.remove();
    if (!$("#platform-editor").children.length) setPlatformRows([{ nombre: "Netflix", verificacion: "por verificar" }]);
  });
  return row;
}

function readPlatformRows() {
  return $$("#platform-editor .platform-row")
    .map((row) => {
      const sel = row.querySelector(".plat-sel").value;
      const nombre =
        sel === "__otra__" ? row.querySelector(".plat-otra").value.trim() : sel;
      return {
        nombre,
        verificacion: row.querySelector(".plat-verif").value,
      };
    })
    .filter((p) => p.nombre);
}

function syncTipoFields() {
  const serie = $("#f-tipo").value === "serie";
  $("#wrap-duracion").hidden = serie;
  $("#wrap-temporadas").hidden = !serie;
  $("#wrap-temporada").hidden = !serie;
}

function openForm(titulo = null) {
  state.editId = titulo ? titulo.id : null;
  $("#modal-form-title").textContent = titulo ? "Editar título" : "Añadir título";
  $("#f-id").value = titulo?.id || "";
  $("#f-titulo").value = titulo?.titulo || "";
  $("#f-tipo").value = titulo?.tipo || "pelicula";
  $("#f-anio").value = titulo?.anio ?? "";
  $("#f-generos").value = (titulo?.generos || []).join(", ");
  $("#f-sinopsis").value = titulo?.sinopsis || "";
  $("#f-duracion").value = titulo?.duracion && typeof titulo.duracion === "object" ? titulo.duracion.minutos ?? "" : titulo?.duracion ?? "";
  $("#f-temporadas").value = titulo?.temporadas ?? "";
  $("#f-temporada").value = titulo?.temporada ?? "";
  $("#f-poster").value = titulo?.poster || "";
  $("#f-estado").value = titulo?.estado === "vista" ? "vista" : "pendiente";
  $("#f-puntuacion").value = titulo?.puntuacion ?? "";
  $("#f-favorita").checked = Boolean(titulo?.favorita);
  $("#f-notas").value = titulo?.notas || "";
  setPlatformRows(titulo?.plataformas || []);
  syncTipoFields();
  openModal("#modal-form");
  $("#f-titulo").focus();
}

function collectForm() {
  const generos = $("#f-generos").value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const puntuacionRaw = $("#f-puntuacion").value;
  const puntuacion = puntuacionRaw === "" ? null : Number(puntuacionRaw);
  const existingId = state.editId;
  const typedId = $("#f-id").value.trim();
  return {
    id: existingId || typedId || uid(),
    titulo: $("#f-titulo").value.trim(),
    tipo: $("#f-tipo").value,
    anio: $("#f-anio").value ? Number($("#f-anio").value) : null,
    generos,
    sinopsis: $("#f-sinopsis").value.trim(),
    duracion: $("#f-duracion").value ? Number($("#f-duracion").value) : null,
    temporadas: $("#f-temporadas").value ? Number($("#f-temporadas").value) : null,
    temporada: $("#f-temporada").value ? Number($("#f-temporada").value) : null,
    poster: $("#f-poster").value.trim(),
    estado: $("#f-estado").value === "vista" ? "vista" : "pendiente",
    puntuacion: Number.isFinite(puntuacion) ? puntuacion : null,
    favorita: $("#f-favorita").checked,
    notas: $("#f-notas").value.trim(),
    plataformas: readPlatformRows(),
  };
}

/** Acepta el formato enriquecido y las duraciones numéricas de JSON antiguos. */
function formatDuracion(t) {
  const duration = t.duracion;
  const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : null;
  if (t.tipo === "serie") {
    const seasons = positive(duration?.temporadas ?? t.temporadas);
    const minutes = positive(duration?.minutos_episodio);
    return [seasons ? `${seasons} ${seasons === 1 ? "temporada" : "temporadas"}` : null,
      minutes ? `~${minutes} min/ep` : null].filter(Boolean).join(" · ");
  }
  const minutes = positive(typeof duration === "object" && duration ? duration.minutos : duration);
  if (!minutes) return "";
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return [hours ? `${hours} h` : null, rest ? `${rest} min` : null].filter(Boolean).join(" ");
}

function backdropDisponible(t) {
  const status = [t.extras_info?.nota, t.backdrop_estado].filter(Boolean).join(" ");
  return /^https?:\/\//i.test(String(t.backdrop || "")) && !/por verificar/i.test(status);
}

function detailHeroHtml(t, meta) {
  const backdrop = backdropDisponible(t);
  const extraNote = /por verificar/i.test(t.extras_info?.nota || "") ? " · Datos extra por verificar" : "";
  return `<div class="detail-hero" data-backdrop="${backdrop ? "verified" : t.poster ? "poster" : "plain"}">
    ${t.poster ? `<img class="detail-poster-blur" src="${escapeHtml(t.poster)}" alt="" aria-hidden="true" />` : ""}
    ${backdrop ? `<img class="detail-backdrop" src="${escapeHtml(t.backdrop)}" alt="" aria-hidden="true" />` : ""}
    <div class="detail-hero-shade"></div>
    <div class="detail-hero-copy"><p class="eyebrow">TU PRÓXIMA SESIÓN</p><h3>${escapeHtml(t.titulo)}</h3><p class="detail-meta">${escapeHtml(meta + extraNote)}</p></div>
  </div>`;
}

function openDetalle(t) {
  state.detalleId = t.id;
  const sinMarcar =
    Boolean(t._sinMarcar) || !state.db.lista.some((x) => x.id === t.id);
  const grouped = agruparStreamingParaFicha(t.streaming_es || []);
  const meta = sinMarcar
    ? [
        t.tipo === "serie" ? "Serie" : "Película",
        t.anio || "¿?",
        formatDuracion(t),
        "Sin marcar",
      ]
        .filter(Boolean)
        .join(" · ")
    : [
        t.tipo === "serie" ? "Serie" : "Película",
        t.anio || "¿?",
        formatDuracion(t),
        tieneProgreso(t) ? formatProgreso(t) : null,
        labelEstado(t.estado),
        t.puntuacion != null ? `Puntuación ${t.puntuacion}/10` : "Sin puntuación",
        t.favorita ? "Favorita" : null,
      ]
        .filter(Boolean)
        .join(" · ");

  const renderGroup = (items) => {
    if (!items.length) {
      if (esFichaUsuario(t) && !(t.streaming_es || []).length) {
        return `<p class="meta" style="margin:0"><span class="chip chip-pending">Plataformas por verificar</span></p>`;
      }
      return `<p class="meta" style="margin:0">—</p>`;
    }
    return `<div class="streaming-groups">${items.map((p) => `
      <div class="streaming-platform">
        <h5 class="chip streaming-name">${escapeHtml(p.nombre)}</h5>
        <div class="chips">${p.ofertas.map((oferta) => {
          const warn = oferta.verificacion !== "verificado";
          const label = `${escapeHtml(oferta.etiquetas.join(" · "))}${oferta.nota ? " · " + escapeHtml(oferta.nota) : ""}${warn ? " · Por verificar" : ""}`;
          const inner = oferta.url
            ? `<a href="${escapeHtml(oferta.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(p.nombre)} · ${label}">${label}</a>`
            : label;
          return `<span class="chip ${warn ? "chip-warn" : "chip-ok"}">${inner}</span>`;
        }).join("")}</div>
      </div>`).join("")}</div>`;
  };

  const actions = sinMarcar
    ? `<button class="btn btn-primary" data-det="add-pendiente" data-id="${escapeHtml(t.id)}">Pendiente</button>
          <button class="btn" data-det="add-vista" data-id="${escapeHtml(t.id)}">Vista</button>
          <button class="btn" data-det="fav" data-id="${escapeHtml(t.id)}">★ Añadir a favoritas y pendientes</button>`
    : `<button class="btn btn-primary" data-det="editar" data-id="${escapeHtml(t.id)}">Editar</button>
          <button class="btn" data-det="fav" data-id="${escapeHtml(t.id)}">${t.favorita ? "Quitar favorita" : "Marcar favorita"}</button>
          <button class="btn" data-det="toggle" data-id="${escapeHtml(t.id)}">${t.estado === "vista" ? "Marcar pendiente" : "Marcar vista"}</button>
          <button class="btn btn-danger" data-det="borrar" data-id="${escapeHtml(t.id)}">Borrar</button>`;

  $("#modal-detalle .content").innerHTML = `
    ${detailHeroHtml(t, meta)}
    <div class="detail">
      <div class="poster">${posterHtml(t)}</div>
      <div>
        ${
          t.titulo_original
            ? `<div class="meta">Título original: <em>${escapeHtml(t.titulo_original)}</em></div>`
            : ""
        }
        <div class="detail-section">
          <h4>Sinopsis</h4>
          <p style="margin:0">${escapeHtml(t.sinopsis || "Sin sinopsis.")}</p>
        </div>
        ${
          t.en_cines
            ? `<div class="detail-section"><h4>Cartelera</h4><p style="margin:0"><span class="badge badge-en-cines">En cines</span>${
                t.estreno_es
                  ? ` · Estreno ES: ${escapeHtml(formatFechaDia(t.estreno_es) || t.estreno_es)}`
                  : ""
              }</p></div>`
            : ""
        }
        <div class="detail-section">
          <h4>Géneros</h4>
          <div class="chips">${(t.generos || []).map((g) => `<span class="chip">${escapeHtml(g)}</span>`).join("") || "—"}</div>
        </div>
        <div class="detail-section">
          <h4>Suscripción</h4>
          ${renderGroup(grouped.suscripcion)}
        </div>
        <div class="detail-section">
          <h4>Alquiler/compra</h4>
          ${renderGroup(grouped.alquilerCompra)}
        </div>
        ${
          t.nota
            ? `<div class="detail-section"><h4>Nota de catálogo</h4><p style="margin:0">${escapeHtml(t.nota)}</p></div>`
            : ""
        }
        ${progresoPanelHtml(t, sinMarcar)}
        ${
          sinMarcar
            ? ""
            : `<div class="detail-section">
          <h4>Tu puntuación y tus notas</h4>
          <p style="margin:0 0 8px">${t.puntuacion != null ? `★ ${t.puntuacion}/10` : "Sin puntuación"} · <button type="button" class="btn btn-sm btn-ghost" data-det="editar" data-id="${escapeHtml(t.id)}">Editar puntuación y notas</button></p>
          <p style="margin:0; white-space:pre-wrap">${escapeHtml(t.notas || "—")}</p>
        </div>
        <div class="detail-section">
          <h4>Fechas</h4>
          <p style="margin:0" class="meta">Añadido: ${escapeHtml(formatFecha(t.anadido_en))} · Visto: ${escapeHtml(formatFecha(t.visto_en))}${t.verificado_en ? ` · Catálogo: ${escapeHtml(formatFecha(t.verificado_en))}` : ""}</p>
        </div>`
        }
        ${
          t.trailer
            ? `<div class="detail-section"><h4>Tráiler</h4><p style="margin:0"><a href="${escapeHtml(t.trailer)}" target="_blank" rel="noopener noreferrer">Ver tráiler ↗</a></p></div>`
            : ""
        }
        <div class="card-actions" style="margin-top:1rem">
          ${actions}
        </div>
        ${sinMarcar ? '<p class="meta">Pendiente, Vista o ★ añaden el título a tu lista. Puedes editar después tu puntuación y tus notas.</p>' : ''}
      </div>
    </div>
  `;
  const hero = $("#modal-detalle .detail-hero");
  $$("img", hero).forEach((image) => {
    const fallback = () => {
      image.remove();
      hero.dataset.backdrop = hero.querySelector(".detail-backdrop") ? "verified"
        : hero.querySelector(".detail-poster-blur") ? "poster" : "plain";
    };
    image.addEventListener("error", fallback, { once: true });
    if (image.complete && !image.naturalWidth) fallback();
  });
  openModal("#modal-detalle");
}


function openLogin() {
  const status = $("#login-status");
  if (status) status.textContent = "";
  const email = $("#login-email");
  if (email) email.value = "";
  openModal("#modal-login");
}

async function onLoginSubmit(e) {
  e.preventDefault();
  const sync = syncApi();
  const status = $("#login-status");
  const submit = $("#login-submit");
  const address = String($("#login-email")?.value || "").trim();
  if (!sync) {
    if (status) status.textContent = "El acceso en la nube aún no está disponible en esta copia.";
    return;
  }
  if (!address) {
    if (status) status.textContent = "Escribe tu correo.";
    return;
  }
  if (submit) submit.disabled = true;
  if (status) status.textContent = "Enviando enlace…";
  try {
    const result = await sync.login(address);
    if (result?.ok) {
      if (status) status.textContent = "Revisa tu correo y abre el enlace para entrar. Puedes cerrar esta ventana.";
      toast("Enlace enviado. Revisa tu correo.");
    } else if (result?.skipped) {
      if (status) status.textContent = "Falta configurar el acceso en la nube.";
    } else {
      if (status) status.textContent = result?.error || "No se pudo enviar el enlace.";
    }
  } catch (err) {
    if (status) status.textContent = err?.message || "No se pudo enviar el enlace.";
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function logoutUsuario() {
  const sync = syncApi();
  if (sync) {
    try { await sync.logout(); } catch (err) { console.warn(err); }
  }
  state.auth.user = null;
  renderAuth();
  toast("Sesión cerrada. Tu lista local sigue aquí.");
}

function openBuscarTitulo() {
  const status = $("#tmdb-status");
  const results = $("#tmdb-results");
  if (status) status.textContent = "";
  if (results) results.innerHTML = "";
  const q = $("#tmdb-q");
  if (q) q.value = "";
  openModal("#modal-buscar");
}

async function onBuscarTmdb(e) {
  e.preventDefault();
  const sync = syncApi();
  const status = $("#tmdb-status");
  const box = $("#tmdb-results");
  const q = String($("#tmdb-q")?.value || "").trim();
  if (!q) return;
  if (!sync || !state.auth.user) {
    if (status) status.textContent = "Inicia sesión para buscar títulos en TMDB.";
    return;
  }
  if (status) status.textContent = "Buscando…";
  if (box) box.innerHTML = "";
  try {
    const result = await sync.buscar(q, { tipo: $("#tmdb-tipo")?.value || "multi" });
    if (result?.skipped) {
      if (status) status.textContent = "Inicia sesión para buscar.";
      return;
    }
    if (!result?.ok) {
      if (status) status.textContent = result?.error || "No se pudo buscar.";
      return;
    }
    const items = result.resultados || [];
    if (!items.length) {
      if (status) status.textContent = "Sin resultados. Prueba otro título.";
      return;
    }
    if (status) status.textContent = `${items.length} resultado${items.length === 1 ? "" : "s"}`;
    if (box) {
      box.innerHTML = items.map((item) => {
        const payload = encodeURIComponent(JSON.stringify({
          id: item.id,
          tipo: item.tipo,
          titulo: item.titulo,
          titulo_original: item.titulo_original || "",
          anio: item.anio,
          sinopsis: item.sinopsis || "",
          poster: item.poster || "",
          backdrop: item.backdrop || "",
        }));
        const meta = [item.tipo === "serie" ? "Serie" : "Película", item.anio || "¿?"].join(" · ");
        const poster = item.poster
          ? `<img src="${escapeHtml(item.poster)}" alt="" width="52" height="78" loading="lazy" />`
          : `<div class="tmdb-poster-fallback" aria-hidden="true">Sin póster</div>`;
        return `<article class="tmdb-result">
          ${poster}
          <div><h3>${escapeHtml(item.titulo || "Sin título")}</h3><p class="meta">${escapeHtml(meta)}</p></div>
          <button type="button" class="btn btn-primary" data-tmdb-add="${payload}">Añadir</button>
        </article>`;
      }).join("");
    }
  } catch (err) {
    if (status) status.textContent = err?.message || "No se pudo buscar.";
  }
}

function addFromTmdbResult(resultado) {
  const id = String(resultado?.id || "");
  if (!id) { toast("Falta el id del título"); return false; }
  if (state.db.lista.some((x) => x.id === id)) {
    toast("Ya estaba en tu lista");
    return false;
  }
  // Si ya está en el catálogo verificado, reutiliza esa ficha.
  const catalogada = state.catalogo.find((f) => f.id === id);
  if (catalogada) {
    state.db.fichas[id] = { ...(state.db.fichas[id] || {}), ...catalogada };
    const ok = addFromExplorar(id, "pendiente");
    if (ok) {
      closeModal("#modal-buscar");
      renderAll();
    }
    return ok;
  }
  const ficha = {
    id,
    tipo: resultado.tipo === "serie" ? "serie" : "pelicula",
    titulo: String(resultado.titulo || "").trim() || "Sin título",
    titulo_original: String(resultado.titulo_original || ""),
    anio: resultado.anio != null && resultado.anio !== "" ? Number(resultado.anio) : null,
    generos: [],
    sinopsis: String(resultado.sinopsis || ""),
    poster: resultado.poster || "",
    backdrop: resultado.backdrop || "",
    trailer: "",
    streaming_es: [],
    duracion: null,
    temporadas: null,
    temporada_interes: null,
    nota: "",
    fuentes: ["tmdb-search"],
    origen: "usuario",
    en_cines: false,
    estreno_es: null,
    popularidad_fuente: "",
    extras_info: {},
  };
  // Nunca escribir verificado_en desde el front.
  state.db.fichas[id] = ficha;
  const now = new Date().toISOString();
  const row = Storage.normalizeListaItem({
    id,
    estado: "pendiente",
    favorita: false,
    puntuacion: null,
    notas: "",
    anadido_en: now,
    actualizado_en: now,
    visto_en: null,
    plataformas: [],
    temporada: null,
  });
  state.db.lista.unshift(row);
  persist();
  syncPush({ op: "upsert", item: row, ficha: fichaParaSync(id) });
  closeModal("#modal-buscar");
  renderAll();
  toast("Añadida a pendientes · Plataformas por verificar");
  return true;
}

async function bootSync() {
  const sync = syncApi();
  renderAuth();
  if (!sync) {
    state.auth.ready = true;
    return;
  }
  try {
    const boot = await sync.init();
    state.auth.configured = Boolean(boot?.configured);
    state.auth.user = boot?.user || null;
    renderAuth();
    sync.onAuthChange(({ user }) => {
      state.auth.user = user || null;
      renderAuth();
    });
    if (boot?.user) {
      const remoto = await sync.syncAll(state.db);
      if (remoto?.applied) {
        state.db.lista = remoto.lista;
        state.db.fichas = remoto.fichas;
        if (remoto.misPlataformas) state.db.misPlataformas = normalizarMisPlataformas(remoto.misPlataformas);
        persist();
        if (remoto.switched) toast("Sesión de otra cuenta: cargada su lista");
      }
    }
  } catch (err) {
    console.warn("bootSync", err);
  } finally {
    state.auth.ready = true;
    renderAuth();
  }
}


function openQueVeoHoy() {
  queVeoShuffle = 0;
  const box = $("#queveo-resultados");
  if (box) box.innerHTML = "";
  const otras = $("#btn-otras-ideas");
  if (otras) otras.hidden = true;
  const crit = $("#queveo-criterio-body");
  if (crit) crit.textContent = "";
  openModal("#modal-que-veo");
}

function leerPrefsQueVeo() {
  const tiempo = document.querySelector('input[name="qv-tiempo"]:checked')?.value || "medio";
  return {
    tiempo,
    tipo: $("#qv-tipo")?.value || "ambas",
    animo: $("#qv-animo")?.value || "cualquiera",
  };
}

function renderQueVeoResultados(result) {
  const box = $("#queveo-resultados");
  const otras = $("#btn-otras-ideas");
  const crit = $("#queveo-criterio-body");
  if (!box) return;
  if (crit) {
    const notes = [...result.meta.criterio];
    if (result.meta.sinPlataformas) notes.push("No has marcado plataformas contratadas.");
    crit.innerHTML = notes.map((n) => `<p style="margin:0">${escapeHtml(n)}</p>`).join("");
  }
  if (!result.picks.length) {
    box.innerHTML = `<div class="queveo-empty">No encuentro candidatos con estos criterios. Prueba «Sin límite», otro género o añade títulos a tu lista.</div>`;
    if (otras) otras.hidden = true;
    return;
  }
  if (otras) otras.hidden = false;
  box.innerHTML = result.picks.map(({ t, reasons, avail }) => {
    const title = escapeHtml(t.titulo);
    const poster = t.poster
      ? `<img src="${escapeHtml(t.poster)}" alt="" />`
      : `<div class="queveo-poster-fallback">sin póster</div>`;
    const availNote = avail.sinPlataformas
      ? `<p class="meta" style="margin:4px 0 0">Sin plataformas tuyas configuradas</p>`
      : avail.verified.length
        ? ""
        : avail.pending.length
          ? `<p class="meta" style="margin:4px 0 0"><span class="chip chip-pending">Disponibilidad por verificar</span></p>`
          : `<p class="meta" style="margin:4px 0 0">No está en tus plataformas verificadas</p>`;
    return `<article class="queveo-card" data-id="${escapeHtml(t.id)}">
      ${poster}
      <div>
        <h3>${title}</h3>
        <p class="meta" style="margin:0">${escapeHtml([t.anio || "¿?", t.tipo === "serie" ? "Serie" : "Película", labelEstado(t.estado)].join(" · "))}</p>
        ${availNote}
        <ul class="queveo-reasons">${reasons.slice(0, 4).map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
      </div>
      <button type="button" class="btn" data-queveo-open="${escapeHtml(t.id)}">Ver ficha</button>
    </article>`;
  }).join("");
}

function runQueVeoHoy({ reshuffle = false } = {}) {
  if (reshuffle) queVeoShuffle += 1;
  else queVeoShuffle = 0;
  const result = sugerirQueVeoHoy(leerPrefsQueVeo());
  renderQueVeoResultados(result);
}

function bindEvents() {
  // El alto real del encabezado mantiene los filtros pegados también en móvil.
  const syncHeaderHeight = () => document.documentElement.style.setProperty("--header-height", $(".topbar").getBoundingClientRect().height + "px");
  if ("ResizeObserver" in window) new ResizeObserver(syncHeaderHeight).observe($(".topbar"));
  window.addEventListener("resize", syncHeaderHeight);
  syncHeaderHeight();

  $("#btn-limpiar").addEventListener("click", () => {
    clearTimeout(searchTimer);
    Object.assign(state.filtros, { q: "", estado: "todos", tipo: "todos", plataforma: "todas", genero: "todos", favoritas: false, en_cines: false, mis_plataformas: false, continuar: false });
    $("#busqueda").value = "";
    $("#filtro-estado").value = "todos";
    $("#filtro-tipo").value = "todos";
    renderAll();
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-open-platforms]")) abrirMisPlataformas();
    if (!e.target.closest(".library-menu")) $(".library-menu").open = false;
    if (e.target.closest(".top-actions button")) $(".library-menu").open = false;
  });
  $("#btn-añadir").addEventListener("click", () => {
    if (state.auth.user) openBuscarTitulo();
    else openForm(null);
  });
  $("#btn-entrar")?.addEventListener("click", () => openLogin());
  $("#btn-salir")?.addEventListener("click", () => logoutUsuario());
  $("#form-login")?.addEventListener("submit", onLoginSubmit);
  $("#modal-login")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal("#modal-login"); });
  $("#form-buscar-tmdb")?.addEventListener("submit", onBuscarTmdb);
  $("#modal-buscar")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal("#modal-buscar"); });
  $("#btn-alta-manual")?.addEventListener("click", () => { closeModal("#modal-buscar"); openForm(null); });
  $("#tmdb-results")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tmdb-add]");
    if (!btn) return;
    const raw = btn.dataset.tmdbAdd;
    try { addFromTmdbResult(JSON.parse(decodeURIComponent(raw))); }
    catch (err) { console.warn(err); toast("No se pudo añadir el título"); }
  });
  $("#btn-mis-plataformas").addEventListener("click", abrirMisPlataformas);
  $("#form-mis-plataformas").addEventListener("submit", (e) => {
    e.preventDefault();
    state.db.misPlataformas = normalizarMisPlataformas($$("#platform-choices input:checked").map((input) => input.value));
    persist();
    syncPrefs();
    closeModal("#modal-plataformas");
    renderAll();
    toast("Tus plataformas se han guardado");
  });
  $("#modal-plataformas").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal("#modal-plataformas"); });

  $("#btn-que-veo")?.addEventListener("click", () => openQueVeoHoy());
  $("#form-que-veo")?.addEventListener("submit", (e) => { e.preventDefault(); runQueVeoHoy(); });
  $("#btn-otras-ideas")?.addEventListener("click", () => runQueVeoHoy({ reshuffle: true }));
  $("#modal-que-veo")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal("#modal-que-veo");
    const openBtn = e.target.closest("[data-queveo-open]");
    if (openBtn) {
      const id = openBtn.dataset.queveoOpen;
      const t = getMerged(id) || getMergedOrCatalog(id);
      if (t) { closeModal("#modal-que-veo"); openDetalle(t); }
    }
  });
  $("#filtro-continuar")?.addEventListener("change", (e) => {
    state.filtros.continuar = e.target.checked;
    renderAll();
  });
  $("#continuar-viendo")?.addEventListener("click", (e) => {
    if (e.target.closest("#btn-ver-continuar")) {
      state.filtros.continuar = true;
      const box = $("#filtro-continuar");
      if (box) box.checked = true;
      renderAll();
      $("#grid")?.focus?.();
      return;
    }
    const card = e.target.closest("[data-continuar-id]");
    if (!card) return;
    const t = getMerged(card.dataset.continuarId);
    if (t) openDetalle(t);
  });
  $("#filtro-mis-plataformas").addEventListener("change", (e) => { state.filtros.mis_plataformas = e.target.checked; renderGrid(); });
  $("#score-skip").addEventListener("click", cerrarPuntuacion);
  $("#score-values").addEventListener("click", (e) => { const button = e.target.closest("[data-score]"); if (button) guardarPuntuacion(Number(button.dataset.score)); });

  $("#btn-exportar").addEventListener("click", () => {
    const blob = new Blob([Storage.exportJSON(state.db)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cine-web-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#btn-importar").addEventListener("click", () => $("#file-import").click());
  $("#file-import").addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const imported = Storage.importJSON(text);
      // Merge fichas; lista: imported wins by id
      state.db.fichas = { ...state.db.fichas, ...imported.fichas };
      const map = new Map(state.db.lista.map((t) => [t.id, t]));
      imported.lista.forEach((t) => map.set(t.id, t));
      state.db.lista = [...map.values()];
      if (Array.isArray(imported.seedIds) && imported.seedIds.length) {
        const offered = new Set([...(state.db.seedIds || []), ...imported.seedIds].map(String));
        state.db.seedIds = [...offered];
      }
      state.db.misPlataformas = normalizarMisPlataformas([...(state.db.misPlataformas || []), ...imported.misPlataformas]);
      if (imported.orden) state.db.orden = state.filtros.orden = imported.orden;
      persist();
      const sync = syncApi();
      if (sync && state.auth.user) {
        try {
          const remoto = await sync.syncAll(state.db);
          if (remoto?.applied) {
            state.db.lista = remoto.lista;
            state.db.fichas = remoto.fichas;
            if (remoto.misPlataformas) state.db.misPlataformas = normalizarMisPlataformas(remoto.misPlataformas);
            persist();
          }
        } catch (err) { console.warn("syncAll import", err); }
      }
      renderAll();
      toast(`Importados ${imported.lista.length} títulos`);
    } catch (err) {
      alert("No se pudo importar: " + err.message);
    }
  });

  $("#btn-reseedar").addEventListener("click", async () => {
    if (
      !confirm(
        "¿Vaciar tu lista? Todos los títulos volverán a Sin marcar; no quedará ninguno pendiente ni vista."
      )
    )
      return;
    const ids = state.db.lista.map((t) => t.id);
    const when = new Date().toISOString();
    const seed = await loadSeedArray();
    const catalogExtra = await loadCatalogoArray();
    aplicarCatalogoUnion(seed, catalogExtra);
    aplicarEstadoFresco();
    cerrarPuntuacion();
    if (ids.length) syncPush({ op: "vaciar", ids, actualizado_en: when });
    renderAll();
    toast("Lista vaciada");
  });

  const buscar = (e) => {
    clearTimeout(searchTimer);
    state.filtros.q = e.target.value;
    if (!e.isComposing) searchTimer = setTimeout(renderGrid, 180);
  };
  $("#busqueda").addEventListener("input", buscar);
  $("#busqueda").addEventListener("compositionend", buscar);
  ["filtro-estado", "filtro-tipo", "filtro-plataforma", "filtro-genero", "filtro-orden"].forEach((id) => {
    $("#" + id).addEventListener("change", (e) => {
      const key = {
        "filtro-estado": "estado",
        "filtro-tipo": "tipo",
        "filtro-plataforma": "plataforma",
        "filtro-genero": "genero",
        "filtro-orden": "orden",
      }[id];
      state.filtros[key] = e.target.value;
      if (key === "orden") { state.db.orden = normalizarOrden(e.target.value); persist(); }
      renderGrid();
    });
  });
  $("#filtro-favoritas").addEventListener("change", (e) => {
    state.filtros.favoritas = e.target.checked;
    renderGrid();
  });
  const filtroEnCines = $("#filtro-en-cines");
  if (filtroEnCines) {
    filtroEnCines.addEventListener("change", (e) => {
      state.filtros.en_cines = e.target.checked;
      renderGrid();
    });
  }

  $("#grid").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const card = btn.closest("[data-id]");
    const id = card?.dataset.id;
    if (!id) return;
    const action = btn.dataset.action;
    const mode = card?.dataset.mode || "lista";
    const t = mode === "sin-marcar" ? getMergedOrCatalog(id) : getMerged(id);
    if (!t) return;
    if (action === "detalle") openDetalle(t);
    else if (action === "estado-pendiente" || action === "estado-vista") {
      const next = action === "estado-vista" ? "vista" : "pendiente";
      if (mode === "sin-marcar") addFromExplorar(id, next);
      else if (t.estado !== next) {
        toggleEstado(id);
        toast(next === "vista" ? "Marcada como vista" : "Marcada como pendiente");
      }
      renderAll();
    }
    else if (action === "add-pendiente") {
      if (addFromExplorar(id, "pendiente")) renderAll();
    } else if (action === "add-vista") {
      if (addFromExplorar(id, "vista")) renderAll();
    } else if (action === "editar") openForm(t);
    else if (action === "fav") {
      toggleFavorita(id);
      renderAll();
    } else if (action === "toggle-estado") {
      toggleEstado(id);
      renderAll();
    } else if (action === "borrar") {
      if (confirm(`¿Quitar «${t.titulo}» de tu lista?`)) {
        borrarDeLista(id);
        renderAll();
      }
    }
  });

  $("#modal-detalle").addEventListener("click", (e) => {
    if (e.target === $("#modal-detalle")) closeModal("#modal-detalle");
    const btn = e.target.closest("[data-det]");
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.det;
    if (act === "add-pendiente") {
      if (addFromExplorar(id, "pendiente")) {
        closeModal("#modal-detalle");
        renderAll();
      }
    } else if (act === "add-vista") {
      if (addFromExplorar(id, "vista")) {
        closeModal("#modal-detalle");
        renderAll();
      }
    } else if (act === "editar") {
      closeModal("#modal-detalle");
      openForm(getMerged(id));
    } else if (act === "fav") {
      toggleFavorita(id);
      openDetalle(getMerged(id));
      renderAll();
    } else if (act === "toggle") {
      toggleEstado(id);
      openDetalle(getMerged(id));
      renderAll();
    } else if (act === "borrar") {
      const t = getMerged(id);
      if (t && confirm(`¿Quitar «${t.titulo}» de tu lista?`)) {
        borrarDeLista(id);
        closeModal("#modal-detalle");
        renderAll();
      }
    } else if (act === "prog-guardar") {
      const panel = btn.closest("[data-progress-id]") || $("#modal-detalle");
      const tInput = panel.querySelector('[data-prog="temporada"]');
      const eInput = panel.querySelector('[data-prog="episodio"]');
      const temporada = tInput?.value === "" ? null : Number(tInput.value);
      const episodio = eInput?.value === "" ? null : Number(eInput.value);
      if (asegurarProgreso(id, { temporada, episodio })) {
        toast("Progreso guardado");
        openDetalle(getMerged(id));
        renderAll();
      }
    } else if (act === "prog-siguiente") {
      if (siguienteEpisodio(id)) {
        toast("Siguiente episodio marcado");
        openDetalle(getMerged(id));
        renderAll();
      }
    } else if (act === "prog-temp-sig") {
      if (empezarTemporadaSiguiente(id)) {
        toast("Temporada siguiente empezada");
        openDetalle(getMerged(id));
        renderAll();
      }
    }
  });

  $$("[data-close]").forEach((el) => {
    el.addEventListener("click", () => closeModal(el.dataset.close));
  });
  $("#modal-form").addEventListener("click", (e) => {
    if (e.target === $("#modal-form")) closeModal("#modal-form");
  });

  $("#f-tipo").addEventListener("change", syncTipoFields);
  $("#btn-add-plat").addEventListener("click", () => {
    $("#platform-editor").appendChild(platformRowEl({ nombre: "Netflix", verificacion: "por verificar" }));
  });

  $("#form-titulo").addEventListener("submit", (e) => {
    e.preventDefault();
    const data = collectForm();
    if (!data.titulo) {
      alert("El título es obligatorio.");
      return;
    }
    // Si es alta nueva y el id ya está en lista → toast y no duplicar
    if (!state.editId && state.db.lista.some((x) => x.id === data.id)) {
      toast("Ya estaba en tu lista");
      closeModal("#modal-form");
      return;
    }
    addOrUpdateFromForm(data);
    closeModal("#modal-form");
    renderAll();
  });

  document.addEventListener("keydown", (e) => {
    const modal = $(".modal-backdrop.open");
    if (e.key === "Tab" && modal) {
      const focusable = $$("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']", modal).filter((el) => el.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
    if (e.key === "/" && !modal && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      e.preventDefault(); $("#busqueda").focus();
    }
    if (e.key === "Escape") {
      $(".library-menu").open = false;
      cerrarPuntuacion();
      closeModal("#modal-plataformas");
      closeModal("#modal-form");
      closeModal("#modal-detalle");
      closeModal("#modal-login");
      closeModal("#modal-buscar");
      closeModal("#modal-que-veo");
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  // Una preferencia elegida mientras llega el catálogo no debe guardar una DB vacía.
  const cached = Storage.load();
  if (cached) { state.db = cached; state.filtros.orden = cached.orden; }
  bindEvents();
  try {
    await ensureData();
  } catch (err) {
    console.error(err);
    toast("No se pudo cargar el catálogo semilla");
    state.db = Storage.empty();
    state.catalogo = [];
  }
  await bootSync();
  renderAll();
});
