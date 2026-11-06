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
  return "t_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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

/* ---------- Storage ---------- */
const Storage = (() => {
  const KEY = "cine-web:v2";

  function empty() {
    return { fichas: {}, lista: [], seedIds: [], migracion: null };
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
      return { fichas, lista, seedIds: [], migracion: null };
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

    return {
      id: String(raw.id || uid()),
      estado,
      favorita: Boolean(raw.favorita),
      puntuacion,
      notas: String(raw.notas || ""),
      anadido_en: raw.anadido_en || raw.fechaAñadido || raw.fechaAnadido || new Date().toISOString(),
      visto_en: raw.visto_en || raw.fechaVista || null,
      plataformas,
      temporada:
        raw.temporada != null && raw.temporada !== ""
          ? Number(raw.temporada)
          : null,
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
    orden: "anadido_desc",
  },
  editId: null,
  seedReady: false,
};

function persist() {
  Storage.save(state.db);
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

/** Todas las fichas visibles: lista del usuario + catálogo sin marcar. */
function todosLosTitulos() {
  const marked = state.db.lista.map((row) => getMerged(row.id)).filter(Boolean);
  const unmarked = catalogoFueraDeLista().map(asSinMarcar);
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

function filtrarYOrdenar() {
  const f = state.filtros;
  const q = f.q.trim().toLowerCase();
  let list = todosLosTitulos().filter((t) => {
    if (f.estado === "sin_marcar") {
      if (!t._sinMarcar) return false;
    } else if (f.estado !== "todos") {
      if (t._sinMarcar || t.estado !== f.estado) return false;
    }
    if (f.tipo !== "todos" && t.tipo !== f.tipo) return false;
    if (f.favoritas && (t._sinMarcar || !t.favorita)) return false;
    if (f.en_cines && !t.en_cines) return false;
    if (f.plataforma !== "todas") {
      const ok = (t.plataformas || []).some((p) =>
        plataformaCoincideFiltro(p.nombre, f.plataforma)
      );
      if (!ok) return false;
    }
    if (f.genero !== "todos" && !(t.generos || []).includes(f.genero)) return false;
    if (q) {
      const blob = [
        t.titulo,
        t.titulo_original,
        t.sinopsis,
        t.notas,
        (t.generos || []).join(" "),
        (t.plataformas || []).map((p) => p.nombre).join(" "),
      ]
        .join(" ")
        .toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });

  const unmarkedLast = (cmpFn) => (a, b) => {
    const aU = a._sinMarcar ? 1 : 0;
    const bU = b._sinMarcar ? 1 : 0;
    if (aU !== bU) return aU - bU;
    return cmpFn(a, b);
  };

  const cmp = {
    anadido_desc: unmarkedLast((a, b) =>
      String(b.anadido_en || "").localeCompare(String(a.anadido_en || ""))
    ),
    anadido_asc: unmarkedLast((a, b) =>
      String(a.anadido_en || "").localeCompare(String(b.anadido_en || ""))
    ),
    titulo_asc: (a, b) => a.titulo.localeCompare(b.titulo, "es"),
    titulo_desc: (a, b) => b.titulo.localeCompare(a.titulo, "es"),
    anio_desc: (a, b) => (b.anio || 0) - (a.anio || 0),
    anio_asc: (a, b) => (a.anio || 0) - (b.anio || 0),
    puntuacion_desc: unmarkedLast(
      (a, b) => (b.puntuacion || 0) - (a.puntuacion || 0)
    ),
    puntuacion_asc: unmarkedLast(
      (a, b) => (a.puntuacion || 0) - (b.puntuacion || 0)
    ),
  };
  list.sort(cmp[f.orden] || cmp.anadido_desc);
  return list;
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
  persist();
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
  state.db.lista.unshift(Storage.listaFromSeedFicha(ficha));
  persist();
  return true;
}

/**
 * Añade una ficha de Explorar a la lista con el estado elegido.
 * No toca otras entradas. favorita/puntuacion/notas vacíos; temporada según ficha.
 */
function addFromExplorar(id, estado) {
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
    favorita: false,
    puntuacion: null,
    notas: "",
    anadido_en: now,
    visto_en: esVista ? now : null,
    plataformas: snapshotPlataformasDesdeStreaming(ficha.streaming_es),
    temporada: isMob ? Number(ficha.temporada_interes) || 2 : null,
  });
  state.db.lista.unshift(row);
  persist();
  toast(esVista ? "Añadida como vista" : "Añadida a pendientes");
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
  state.db.lista = state.db.lista.filter((t) => t.id !== id);
  persist();
}

function toggleEstado(id) {
  const t = state.db.lista.find((x) => x.id === id);
  if (!t) return;
  if (t.estado === "vista") {
    t.estado = "pendiente";
    t.visto_en = null;
  } else {
    t.estado = "vista";
    t.visto_en = new Date().toISOString();
  }
  persist();
}

function toggleFavorita(id) {
  const t = state.db.lista.find((x) => x.id === id);
  if (!t) return;
  t.favorita = !t.favorita;
  persist();
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

function plataformasHtml(plataformas) {
  if (!plataformas?.length) return `<span class="chip">Sin suscripción detectada</span>`;
  return plataformas
    .map((p) => {
      const warn = p.verificacion !== "verificado";
      const label = warn ? `${escapeHtml(p.nombre)} · Por verificar` : escapeHtml(p.nombre);
      return `<span class="chip ${warn ? "chip-warn" : "chip-ok"}">${label}</span>`;
    })
    .join("");
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
  const active = f.q || f.estado !== "todos" || f.tipo !== "todos" || f.plataforma !== "todas" || f.genero !== "todos" || f.favoritas || f.en_cines;
  $("#resultados").innerHTML = `<strong>${count}</strong> ${count === 1 ? "título" : "títulos"}${active ? " encontrados" : " para descubrir"}`;
  $("#btn-limpiar").hidden = !active;
  ["estado", "tipo", "plataforma", "genero"].forEach((key) => {
    const select = $("#filtro-" + key);
    select.closest(".filter-control").classList.toggle("is-active", select.value !== (key === "plataforma" ? "todas" : "todos"));
  });
}

function renderFiltrosOpciones() {
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
    grid.innerHTML = `<div class="empty"><strong>Ningún título por aquí… todavía.</strong>No hay títulos con estos filtros. Prueba otra búsqueda o pulsa «Limpiar filtros».</div>`;
    return;
  }
  grid.innerHTML = list.map((t) => {
    const sinMarcar = Boolean(t._sinMarcar);
    const title = escapeHtml(t.titulo);
    const metaBits = [t.anio || "Año por verificar", t.tipo === "serie" ? "Serie" : "Película",
      !sinMarcar && t.tipo === "serie" && t.temporada != null ? `T${t.temporada}` : null,
      !sinMarcar && t.puntuacion != null ? `★ ${t.puntuacion}/10` : null].filter(Boolean).join(" · ");
    const platforms = plataformasCanonicas(t.plataformas);
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
          <button type="button" class="fav-btn ${t.favorita ? "on" : ""}" data-action="fav" aria-pressed="${t.favorita}" aria-label="${sinMarcar ? 'Marca Pendiente o Vista para guardar como favorita: ' : t.favorita ? 'Quitar de favoritas: ' : 'Añadir a favoritas: '}${title}" title="${sinMarcar ? 'Marca Pendiente o Vista antes de guardar favoritas' : t.favorita ? 'Quitar de favoritas' : 'Añadir a favoritas'}" ${sinMarcar ? "disabled" : ""}>★</button>
        </div>
        <div class="card-body">
          <h3 class="card-title"><button class="title-button" type="button" data-action="detalle">${title}</button></h3>
          <div class="meta">${escapeHtml(metaBits)}</div>
          <div class="chips genres">${(t.generos || []).slice(0, 2).map((g) => `<span class="chip">${escapeHtml(g)}</span>`).join("")}</div>
          <div class="chips platforms">${plataformasHtml(platforms.slice(0, 2))}${extraPlatforms}</div>
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

function renderAll() {
  renderHero();
  renderStats();
  renderFiltrosOpciones();
  renderGrid();
}

const modalFocus = new Map();
function openModal(id) {
  const modal = $(id);
  if (!modal.classList.contains("open")) modalFocus.set(id, document.activeElement);
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  $(".app").inert = true;
  document.body.style.overflow = "hidden";
  modal.querySelector("button, input, select, textarea, a[href]")?.focus({ preventScroll: true });
}
function closeModal(id) {
  const modal = $(id);
  if (!modal.classList.contains("open")) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  if (!$(".modal-backdrop.open")) {
    $(".app").inert = false;
    document.body.style.overflow = "";
    const previous = modalFocus.get(id);
    if (previous?.isConnected) previous.focus({ preventScroll: true });
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
        t.temporada != null ? `Temporada ${t.temporada}` : null,
        labelEstado(t.estado),
        t.puntuacion != null ? `Puntuación ${t.puntuacion}/10` : "Sin puntuación",
        t.favorita ? "Favorita" : null,
      ]
        .filter(Boolean)
        .join(" · ");

  const renderGroup = (items) => {
    if (!items.length) return `<p class="meta" style="margin:0">—</p>`;
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
          <button class="btn" data-det="add-vista" data-id="${escapeHtml(t.id)}">Vista</button>`
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
        ${sinMarcar ? '<p class="meta">Elige Pendiente o Vista para guardar puntuación, notas y favoritas en tu lista.</p>' : ''}
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

function bindEvents() {
  // El alto real del encabezado mantiene los filtros pegados también en móvil.
  const syncHeaderHeight = () => document.documentElement.style.setProperty("--header-height", $(".topbar").getBoundingClientRect().height + "px");
  if ("ResizeObserver" in window) new ResizeObserver(syncHeaderHeight).observe($(".topbar"));
  window.addEventListener("resize", syncHeaderHeight);
  syncHeaderHeight();

  $("#btn-limpiar").addEventListener("click", () => {
    Object.assign(state.filtros, { q: "", estado: "todos", tipo: "todos", plataforma: "todas", genero: "todos", favoritas: false, en_cines: false });
    $("#busqueda").value = "";
    $("#filtro-estado").value = "todos";
    $("#filtro-tipo").value = "todos";
    renderAll();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".library-menu")) $(".library-menu").open = false;
    if (e.target.closest(".top-actions button")) $(".library-menu").open = false;
  });
  $("#btn-añadir").addEventListener("click", () => openForm(null));

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
      persist();
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
    const seed = await loadSeedArray();
    const catalogExtra = await loadCatalogoArray();
    aplicarCatalogoUnion(seed, catalogExtra);
    aplicarEstadoFresco();
    renderAll();
    toast("Lista vaciada");
  });

  $("#busqueda").addEventListener("input", (e) => {
    state.filtros.q = e.target.value;
    renderGrid();
  });
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
      closeModal("#modal-form");
      closeModal("#modal-detalle");
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  try {
    await ensureData();
  } catch (err) {
    console.error(err);
    toast("No se pudo cargar el catálogo semilla");
    state.db = Storage.empty();
    state.catalogo = [];
  }
  renderAll();
});
