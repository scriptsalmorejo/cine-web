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
  const seen = new Set();
  const out = [];
  for (const s of streamingEs || []) {
    if (s.tipo !== "subscription") continue;
    if (esTiendaAlquilerCompra(s.plataforma)) continue;
    const nombre = normalizarNombreSuscripcion(s.plataforma);
    // Max Amazon Channel se muestra aparte (no se colapsa a Max)
    const display =
      s.plataforma === "Max Amazon Channel" ? "Max Amazon Channel" : nombre;
    if (seen.has(display)) continue;
    seen.add(display);
    const verif =
      String(s.estado || "").toLowerCase() === "verificado"
        ? "verificado"
        : "por verificar";
    out.push({ nombre: display, verificacion: verif });
  }
  return out;
}

function agruparStreamingParaFicha(streamingEs) {
  const byName = new Map();
  for (const s of streamingEs || []) {
    const nombre = s.plataforma;
    if (!byName.has(nombre)) {
      byName.set(nombre, {
        nombre,
        url: s.url || "",
        tipos: new Set(),
        verificacion:
          String(s.estado || "").toLowerCase() === "verificado"
            ? "verificado"
            : "por verificar",
      });
    }
    const g = byName.get(nombre);
    g.tipos.add(s.tipo);
    if (s.url && !g.url) g.url = s.url;
    if (String(s.estado || "").toLowerCase() === "verificado") g.verificacion = "verificado";
  }
  const suscripcion = [];
  const alquilerCompra = [];
  for (const g of byName.values()) {
    const tipos = [...g.tipos];
    const item = {
      nombre: g.nombre,
      url: g.url,
      verificacion: g.verificacion,
      tipos,
      etiquetas: tipos.map((t) => TIPO_STREAM[t] || t),
    };
    if (tipos.includes("subscription") && !esTiendaAlquilerCompra(g.nombre)) {
      suscripcion.push(item);
    } else if (tipos.some((t) => t === "rent" || t === "buy") || esTiendaAlquilerCompra(g.nombre)) {
      alquilerCompra.push(item);
    } else {
      suscripcion.push(item);
    }
  }
  return { suscripcion, alquilerCompra };
}

function plataformaCoincideFiltro(nombreEnLista, filtro) {
  if (filtro === "todas") return true;
  if (nombreEnLista === filtro) return true;
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
    return { fichas: {}, lista: [], seedIds: [] };
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
        // Ausente en v2 antigua: se normaliza en mergeSeedIntoDb
        seedIds: Array.isArray(data.seedIds) ? data.seedIds.map(String) : null,
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
      return { fichas, lista, seedIds: [] };
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
      trailer: raw.trailer || "",
      streaming_es: Array.isArray(raw.streaming_es) ? raw.streaming_es : [],
      duracion: raw.duracion != null ? Number(raw.duracion) : null,
      temporadas: raw.temporadas != null ? Number(raw.temporadas) : null,
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
  vista: "lista", // "lista" | "explorar"
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
  return { total: state.db.lista.length, pendientes, vistas, favoritas };
}

function idsEnListaSet() {
  return new Set(state.db.lista.map((r) => r.id));
}

/** Fichas del catálogo que aún no están en la lista del usuario. */
function catalogoFueraDeLista() {
  const enLista = idsEnListaSet();
  return state.catalogo.filter((f) => f && f.id && !enLista.has(f.id));
}

function plataformasParaFiltro() {
  const extras = new Set();
  const addPlat = (nombre) => {
    if (!nombre || nombre === "Max Amazon Channel") return;
    if (!PLATAFORMAS_ES.includes(nombre)) extras.add(nombre);
  };
  if (state.vista === "explorar") {
    catalogoFueraDeLista().forEach((f) => {
      snapshotPlataformasDesdeStreaming(f.streaming_es).forEach((p) => addPlat(p.nombre));
    });
  } else {
    state.db.lista.forEach((row) =>
      (row.plataformas || []).forEach((p) => addPlat(p.nombre))
    );
  }
  const extraList = [...extras].sort((a, b) => a.localeCompare(b, "es"));
  return [...PLATAFORMAS_ES, ...extraList];
}

function generosDisponibles() {
  const set = new Set();
  if (state.vista === "explorar") {
    catalogoFueraDeLista().forEach((f) => (f.generos || []).forEach((g) => set.add(g)));
  } else {
    state.db.lista.forEach((row) => {
      const f = state.db.fichas[row.id];
      (f?.generos || []).forEach((g) => set.add(g));
    });
  }
  return [...set].sort((a, b) => a.localeCompare(b, "es"));
}

function filtrarYOrdenar() {
  const f = state.filtros;
  const q = f.q.trim().toLowerCase();
  let list = state.db.lista
    .map((row) => getMerged(row.id))
    .filter(Boolean)
    .filter((t) => {
      if (f.estado !== "todos" && t.estado !== f.estado) return false;
      if (f.tipo !== "todos" && t.tipo !== f.tipo) return false;
      if (f.favoritas && !t.favorita) return false;
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

  const cmp = {
    anadido_desc: (a, b) => String(b.anadido_en).localeCompare(String(a.anadido_en)),
    anadido_asc: (a, b) => String(a.anadido_en).localeCompare(String(b.anadido_en)),
    titulo_asc: (a, b) => a.titulo.localeCompare(b.titulo, "es"),
    titulo_desc: (a, b) => b.titulo.localeCompare(a.titulo, "es"),
    anio_desc: (a, b) => (b.anio || 0) - (a.anio || 0),
    anio_asc: (a, b) => (a.anio || 0) - (b.anio || 0),
    puntuacion_desc: (a, b) => (b.puntuacion || 0) - (a.puntuacion || 0),
    puntuacion_asc: (a, b) => (a.puntuacion || 0) - (b.puntuacion || 0),
  };
  list.sort(cmp[f.orden] || cmp.anadido_desc);
  return list;
}

function filtrarCatalogoExplorar() {
  const f = state.filtros;
  const q = f.q.trim().toLowerCase();
  let list = catalogoFueraDeLista().map((ficha) => ({
    ...ficha,
    plataformas: snapshotPlataformasDesdeStreaming(ficha.streaming_es),
    _explorar: true,
  }));
  list = list.filter((t) => {
    if (f.tipo !== "todos" && t.tipo !== f.tipo) return false;
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
        (t.generos || []).join(" "),
        (t.plataformas || []).map((p) => p.nombre).join(" "),
      ]
        .join(" ")
        .toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
  const cmp = {
    anadido_desc: (a, b) => String(b.titulo || "").localeCompare(String(a.titulo || ""), "es"),
    anadido_asc: (a, b) => String(a.titulo || "").localeCompare(String(b.titulo || ""), "es"),
    titulo_asc: (a, b) => a.titulo.localeCompare(b.titulo, "es"),
    titulo_desc: (a, b) => b.titulo.localeCompare(a.titulo, "es"),
    anio_desc: (a, b) => (b.anio || 0) - (a.anio || 0),
    anio_asc: (a, b) => (a.anio || 0) - (b.anio || 0),
    puntuacion_desc: (a, b) => a.titulo.localeCompare(b.titulo, "es"),
    puntuacion_asc: (a, b) => a.titulo.localeCompare(b.titulo, "es"),
  };
  list.sort(cmp[f.orden] || cmp.titulo_asc);
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

function aplicarCatalogo(rawArr) {
  const byId = new Map();
  for (const raw of rawArr || []) {
    const ficha = Storage.fichaFromSeed(raw);
    if (!ficha.id) continue;
    byId.set(ficha.id, ficha);
  }
  state.catalogo = [...byId.values()];
}

function aplicarSeed(seedArr) {
  const fichas = {};
  const lista = [];
  for (const raw of seedArr) {
    const ficha = Storage.fichaFromSeed(raw);
    fichas[ficha.id] = ficha;
    lista.push(Storage.listaFromSeedFicha(ficha));
  }
  state.db = { fichas, lista, seedIds: Object.keys(fichas) };
  persist();
}

/**
 * Fusiona el seed en una BD ya existente:
 * - actualiza fichas por id (streaming, en_cines, etc.)
 * - refresca snapshot plataformas de entradas ya en lista (sin tocar estado/★/notas/puntuación/visto_en)
 * - añade como pendiente solo ids de seed nunca ofrecidos (seedIds)
 * Migración: si seedIds es null, se inicializa con las fichas ya conocidas (así un borrado previo no reaparece).
 */
function mergeSeedIntoDb(seedArr) {
  if (!state.db.fichas) state.db.fichas = {};
  if (!Array.isArray(state.db.lista)) state.db.lista = [];
  if (!Array.isArray(state.db.seedIds)) {
    // null/ausente → migrar: lo ya conocido en fichas se considera ofrecido
    state.db.seedIds = Object.keys(state.db.fichas);
  }
  const offered = new Set(state.db.seedIds.map(String));
  for (const raw of seedArr) {
    const ficha = Storage.fichaFromSeed(raw);
    const id = ficha.id;
    state.db.fichas[id] = { ...(state.db.fichas[id] || {}), ...ficha };

    const row = state.db.lista.find((x) => x.id === id);
    if (row) {
      row.plataformas = snapshotPlataformasDesdeStreaming(ficha.streaming_es);
    } else if (!offered.has(id)) {
      state.db.lista.push(Storage.listaFromSeedFicha(ficha));
    }
    offered.add(id);
  }
  state.db.seedIds = [...offered];
}

async function ensureData() {
  const seed = await loadSeedArray();
  const loaded = Storage.load();
  if (loaded && loaded.lista.length) {
    state.db = loaded;
    mergeSeedIntoDb(seed);
    persist();
  } else {
    aplicarSeed(seed);
  }
  // Catálogo de Explorar: nunca se auto-añade a la lista
  aplicarCatalogo(await loadCatalogoArray());
  state.seedReady = true;
}

/* ---------- CRUD lista ---------- */
function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
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
    duracion: data.duracion,
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
  return {
    ...ficha,
    plataformas: snapshotPlataformasDesdeStreaming(ficha.streaming_es),
    _explorar: true,
    estado: null,
    favorita: false,
    puntuacion: null,
    notas: "",
    anadido_en: null,
    visto_en: null,
  };
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
  return e === "vista" ? "Vista" : "Pendiente";
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

function setVista(vista) {
  state.vista = vista === "explorar" ? "explorar" : "lista";
  document.body.classList.toggle("vista-explorar", state.vista === "explorar");
  $$(".tabs .tab").forEach((btn) => {
    const active = btn.dataset.vista === state.vista;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  const busqueda = $("#busqueda");
  if (busqueda) {
    busqueda.placeholder =
      state.vista === "explorar"
        ? "Buscar en el catálogo…"
        : "Buscar título, género, notas…";
  }
  // Si el orden actual es solo-lista y estamos en explorar, caer a título
  if (
    state.vista === "explorar" &&
    ["anadido_desc", "anadido_asc", "puntuacion_desc", "puntuacion_asc"].includes(
      state.filtros.orden
    )
  ) {
    state.filtros.orden = "titulo_asc";
    const ord = $("#filtro-orden");
    if (ord) ord.value = "titulo_asc";
  }
  renderAll();
}

function renderStats() {
  if (state.vista === "explorar") {
    const totalCat = state.catalogo.length;
    const disponibles = catalogoFueraDeLista().length;
    const enLista = totalCat - disponibles;
    $("#stats").innerHTML = `
      <div class="stat"><strong>${disponibles}</strong> por descubrir</div>
      <div class="stat"><strong>${enLista}</strong> ya en tu lista</div>
      <div class="stat"><strong>${totalCat}</strong> en catálogo</div>
    `;
    return;
  }
  const c = contadores();
  $("#stats").innerHTML = `
    <div class="stat"><strong>${c.total}</strong> títulos</div>
    <div class="stat"><strong>${c.pendientes}</strong> pendientes</div>
    <div class="stat"><strong>${c.vistas}</strong> vistas</div>
    <div class="stat"><strong>${c.favoritas}</strong> favoritas</div>
  `;
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
  const explorar = state.vista === "explorar";
  const list = explorar ? filtrarCatalogoExplorar() : filtrarYOrdenar();
  const grid = $("#grid");
  if (!list.length) {
    grid.innerHTML = explorar
      ? `<div class="empty">No hay títulos del catálogo con estos filtros${
          state.catalogo.length ? "" : " (el catálogo aún está vacío)"
        }. Los que quites de tu lista volverán a aparecer aquí.</div>`
      : `<div class="empty">No hay títulos con estos filtros. Prueba a limpiar la búsqueda o añade uno nuevo.</div>`;
    return;
  }
  grid.innerHTML = list
    .map((t) => {
      const metaBits = [
        t.tipo === "serie" ? "Serie" : "Película",
        t.anio || "¿?",
        !explorar && t.tipo === "serie" && t.temporada != null
          ? `Temp. ${t.temporada}`
          : null,
        !explorar && t.puntuacion != null ? `★ ${t.puntuacion}/10` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      const badgeEstado = explorar
        ? `<span class="badge badge-tipo">Catálogo</span>`
        : `<span class="badge badge-tipo">${escapeHtml(labelEstado(t.estado))}</span>`;

      const favBtn = explorar
        ? ""
        : `<button type="button" class="fav-btn ${t.favorita ? "on" : ""}" data-action="fav" title="Favorita" aria-label="Favorita" aria-pressed="${t.favorita}">★</button>`;

      const actions = explorar
        ? `<button class="btn btn-sm btn-primary" data-action="detalle">Ficha</button>
            <button class="btn btn-sm" data-action="add-pendiente">Pendiente</button>
            <button class="btn btn-sm" data-action="add-vista">Vista</button>`
        : `<button class="btn btn-sm btn-primary" data-action="detalle">Ficha</button>
            <button class="btn btn-sm" data-action="toggle-estado">${t.estado === "vista" ? "→ Pendiente" : "→ Vista"}</button>
            <button class="btn btn-sm" data-action="editar">Editar</button>
            <button class="btn btn-sm btn-danger" data-action="borrar">Borrar</button>`;

      return `
      <article class="card" data-id="${escapeHtml(t.id)}" data-mode="${explorar ? "explorar" : "lista"}">
        <div class="poster">
          ${posterHtml(t)}
          <div class="badge-row">
            ${badgeEstado}
            ${t.en_cines ? `<span class="badge badge-en-cines">En cines${t.estreno_es ? ` · ${escapeHtml(formatFechaDia(t.estreno_es) || t.estreno_es)}` : ""}</span>` : ""}
          </div>
          ${favBtn}
        </div>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(t.titulo)}</h3>
          <div class="meta">${escapeHtml(metaBits)}</div>
          <div class="chips">${(t.generos || []).slice(0, 3).map((g) => `<span class="chip">${escapeHtml(g)}</span>`).join("")}</div>
          <div class="chips">${plataformasHtml(t.plataformas)}</div>
          <div class="card-actions">
            ${actions}
          </div>
        </div>
      </article>`;
    })
    .join("");
}

function renderAll() {
  renderStats();
  renderFiltrosOpciones();
  renderGrid();
}

function openModal(id) {
  $(id).classList.add("open");
  $(id).setAttribute("aria-hidden", "false");
}
function closeModal(id) {
  $(id).classList.remove("open");
  $(id).setAttribute("aria-hidden", "true");
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
    <select class="select plat-sel">${platformOptionsHtml(otra ? null : p.nombre || "Netflix")}</select>
    <input class="field plat-otra" placeholder="Nombre de la plataforma" ${otra ? "" : "hidden"} value="${otra ? escapeHtml(p.nombre) : ""}" />
    <select class="select plat-verif">
      <option value="por verificar"${p.verificacion !== "verificado" ? " selected" : ""}>Por verificar</option>
      <option value="verificado"${p.verificacion === "verificado" ? " selected" : ""}>Verificado</option>
    </select>
    <button type="button" class="btn btn-sm btn-danger plat-remove" title="Quitar">✕</button>
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
  $("#f-duracion").value = titulo?.duracion ?? "";
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

function openDetalle(t) {
  const explorar = Boolean(t._explorar) || (state.vista === "explorar" && !state.db.lista.some((x) => x.id === t.id));
  const grouped = agruparStreamingParaFicha(t.streaming_es || []);
  const meta = explorar
    ? [
        t.tipo === "serie" ? "Serie" : "Película",
        t.anio || "¿?",
        "Catálogo",
      ]
        .filter(Boolean)
        .join(" · ")
    : [
        t.tipo === "serie" ? "Serie" : "Película",
        t.anio || "¿?",
        t.temporada != null ? `Temporada ${t.temporada}` : null,
        labelEstado(t.estado),
        t.puntuacion != null ? `Puntuación ${t.puntuacion}/10` : "Sin puntuación",
        t.favorita ? "Favorita" : null,
      ]
        .filter(Boolean)
        .join(" · ");

  const renderGroup = (items) => {
    if (!items.length) return `<p class="meta" style="margin:0">—</p>`;
    return `<div class="chips">${items
      .map((p) => {
        const warn = p.verificacion !== "verificado";
        const tipos = p.etiquetas.join(" · ");
        const label = `${escapeHtml(p.nombre)} · ${escapeHtml(tipos)}${warn ? " · Por verificar" : ""}`;
        const inner = p.url
          ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
          : label;
        return `<span class="chip ${warn ? "chip-warn" : "chip-ok"}">${inner}</span>`;
      })
      .join("")}</div>`;
  };

  const actions = explorar
    ? `<button class="btn btn-primary" data-det="add-pendiente" data-id="${escapeHtml(t.id)}">Pendiente</button>
          <button class="btn" data-det="add-vista" data-id="${escapeHtml(t.id)}">Vista</button>`
    : `<button class="btn btn-primary" data-det="editar" data-id="${escapeHtml(t.id)}">Editar</button>
          <button class="btn" data-det="fav" data-id="${escapeHtml(t.id)}">${t.favorita ? "Quitar favorita" : "Marcar favorita"}</button>
          <button class="btn" data-det="toggle" data-id="${escapeHtml(t.id)}">${t.estado === "vista" ? "Marcar pendiente" : "Marcar vista"}</button>
          <button class="btn btn-danger" data-det="borrar" data-id="${escapeHtml(t.id)}">Borrar</button>`;

  $("#modal-detalle .content").innerHTML = `
    <div class="detail">
      <div class="poster">${posterHtml(t)}</div>
      <div>
        <h3>${escapeHtml(t.titulo)}</h3>
        ${
          t.titulo_original
            ? `<div class="meta">Título original: <em>${escapeHtml(t.titulo_original)}</em></div>`
            : ""
        }
        <div class="meta">${escapeHtml(meta)}</div>
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
        <div class="detail-section">
          <h4>Sinopsis</h4>
          <p style="margin:0">${escapeHtml(t.sinopsis || "Sin sinopsis.")}</p>
        </div>
        ${
          t.nota
            ? `<div class="detail-section"><h4>Nota de catálogo</h4><p style="margin:0">${escapeHtml(t.nota)}</p></div>`
            : ""
        }
        ${
          explorar
            ? ""
            : `<div class="detail-section">
          <h4>Notas</h4>
          <p style="margin:0; white-space:pre-wrap">${escapeHtml(t.notas || "—")}</p>
        </div>
        <div class="detail-section">
          <h4>Fechas</h4>
          <p style="margin:0" class="meta">Añadido: ${escapeHtml(formatFecha(t.anadido_en))} · Visto: ${escapeHtml(formatFecha(t.visto_en))}${t.verificado_en ? ` · Catálogo: ${escapeHtml(formatFecha(t.verificado_en))}` : ""}</p>
        </div>`
        }
        ${
          t.trailer
            ? `<div class="detail-section"><h4>Trailer</h4><p style="margin:0"><a href="${escapeHtml(t.trailer)}" target="_blank" rel="noopener noreferrer">Ver trailer</a></p></div>`
            : ""
        }
        <div class="card-actions" style="margin-top:1rem">
          ${actions}
        </div>
      </div>
    </div>
  `;
  openModal("#modal-detalle");
}

function bindEvents() {
  $$(".tabs .tab").forEach((btn) => {
    btn.addEventListener("click", () => setVista(btn.dataset.vista));
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
    if (!confirm("¿Restablecer la lista con el catálogo semilla? Se sustituye lo guardado en este navegador.")) return;
    const seed = await loadSeedArray();
    aplicarSeed(seed);
    // Explorar (catalogo.json) no se toca
    renderAll();
    toast("Catálogo semilla cargado");
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
    const mode = card?.dataset.mode || state.vista;
    const t = mode === "explorar" ? getMergedOrCatalog(id) : getMerged(id);
    if (!t) return;
    if (action === "detalle") openDetalle(t);
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
    if (e.key === "Escape") {
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
  setVista(state.vista || "lista");
});
