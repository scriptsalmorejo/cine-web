import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  cacheKey,
  canonicalPlataformas,
  mergeCustomTitles,
  mergePrefs,
  mergeUserTitles,
  planCustom,
  planLocalPrefs,
  planLocalRows,
  prefsCloudALocal,
  prefsLocalACloud,
  proyectarPendientes,
  syncMode,
  timeOf,
} from "./merge.js";

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-11-01T00:00:00.000Z";
const T2 = "2026-11-03T00:00:00.000Z";
const T3 = "2026-11-06T00:00:00.000Z";

function item(partial) {
  return {
    id: "tmdb:1",
    estado: "pendiente",
    favorita: false,
    puntuacion: null,
    notas: "",
    anadido_en: T0,
    visto_en: null,
    temporada: null,
    plataformas: [],
    ...partial,
  };
}

function fusion(lista, remote, cache = [], now = T3) {
  const localRows = planLocalRows({ lista, cache, now });
  return mergeUserTitles({
    localRows,
    remoteRows: remote,
    order: (lista || []).map((row) => row.id),
  });
}

test("timeOf prefiere actualizado_en, luego visto_en, luego anadido_en", () => {
  assert.equal(timeOf({ actualizado_en: T1, visto_en: T3, anadido_en: T0 }), Date.parse(T1));
  assert.equal(timeOf({ visto_en: T1, anadido_en: T3 }), Date.parse(T1));
  assert.equal(timeOf({ anadido_en: T0 }), Date.parse(T0));
  assert.equal(timeOf({}), Number.NEGATIVE_INFINITY);
  assert.equal(timeOf({ actualizado_en: "no-es-fecha", visto_en: T2 }), Date.parse(T2));
});

test("el reloj del front gana y un empate se queda con la nube", () => {
  const localGana = fusion(
    [item({ notas: "en casa", actualizado_en: T3 })],
    [item({ notas: "en la nube", actualizado_en: T1, borrado: false })],
  );
  assert.equal(localGana.lista[0].notas, "en casa");
  assert.equal(localGana.toUpsert.length, 1);

  const nubeGana = fusion(
    [item({ estado: "pendiente", actualizado_en: T1 })],
    [item({ estado: "vista", visto_en: T2, actualizado_en: T2, borrado: false })],
  );
  assert.equal(nubeGana.lista[0].estado, "vista");
  assert.equal(nubeGana.toUpsert.length, 0);

  const empate = fusion(
    [item({ notas: "local", actualizado_en: T2 })],
    [item({ notas: "nube", actualizado_en: T2, borrado: false })],
  );
  assert.equal(empate.lista[0].notas, "nube");
  assert.equal(empate.toUpsert.length, 0);
});

test("vaciar notas o la puntuación es un valor: si es más reciente, gana", () => {
  const notas = fusion(
    [item({ notas: "", actualizado_en: T3 })],
    [item({ notas: "buena", actualizado_en: T1, borrado: false })],
  );
  assert.equal(notas.lista[0].notas, "");
  assert.equal(notas.toUpsert[0].notas, "");

  const puntos = fusion(
    [item({ puntuacion: null, actualizado_en: T3 })],
    [item({ puntuacion: 8, actualizado_en: T1, borrado: false })],
  );
  assert.equal(puntos.lista[0].puntuacion, null);
  assert.equal(puntos.toUpsert[0].puntuacion, null);
});

test("sin actualizado_en se deriva visto_en || anadido_en, no el máximo de los dos", () => {
  const vistoMasReciente = mergeUserTitles({
    localRows: [item({ actualizado_en: null, visto_en: T2, anadido_en: T0, notas: "vista" })],
    remoteRows: [item({ actualizado_en: T1, notas: "nube", borrado: false })],
    order: ["tmdb:1"],
  });
  assert.equal(vistoMasReciente.lista[0].notas, "vista");

  const anadidoNoPisaUnVistoAnterior = mergeUserTitles({
    localRows: [item({ actualizado_en: null, visto_en: T1, anadido_en: T3, notas: "local" })],
    remoteRows: [item({ actualizado_en: T2, notas: "nube", borrado: false })],
    order: ["tmdb:1"],
  });
  assert.equal(anadidoNoPisaUnVistoAnterior.lista[0].notas, "nube");
  assert.equal(anadidoNoPisaUnVistoAnterior.toUpsert.length, 0);
});

test("tombstone reciente borra; uno viejo no resucita ni pisa un edit posterior", () => {
  const nubeBorra = fusion(
    [item({ notas: "sigo", actualizado_en: T1 })],
    [item({ notas: "sigo", actualizado_en: T3, borrado: true })],
  );
  assert.equal(nubeBorra.lista.length, 0);
  assert.equal(nubeBorra.toUpsert.length, 0);

  const localBorra = fusion(
    [],
    [item({ notas: "en nube", actualizado_en: T1, borrado: false })],
    [item({ notas: "en nube", actualizado_en: T1, borrado: false })],
    T3,
  );
  assert.equal(localBorra.lista.length, 0);
  assert.equal(localBorra.toUpsert.length, 1);
  assert.equal(localBorra.toUpsert[0].borrado, true);
  assert.equal(localBorra.toUpsert[0].actualizado_en, T3);
  assert.notEqual(localBorra.toUpsert[0].estado, "sin_marcar");

  const editPosterior = mergeUserTitles({
    localRows: [item({ borrado: true, actualizado_en: T1, notas: "viejo" })],
    remoteRows: [item({ borrado: false, actualizado_en: T3, notas: "la recuperé", estado: "vista" })],
    order: [],
  });
  assert.equal(editPosterior.lista.length, 1);
  assert.equal(editPosterior.lista[0].notas, "la recuperé");
  assert.equal(editPosterior.lista[0].estado, "vista");
  assert.equal(editPosterior.toUpsert.length, 0);
});

test("sin_marcar no se guarda: pasa a tombstone y no sale en la lista", () => {
  const planned = planLocalRows({
    lista: [item({ estado: "sin_marcar", actualizado_en: T2, notas: "adiós" })],
    cache: [],
    now: T3,
  });
  assert.equal(planned[0].borrado, true);
  assert.equal(planned[0].estado, "pendiente");
  assert.equal(JSON.stringify(planned).includes("sin_marcar"), false);

  const merged = mergeUserTitles({ localRows: planned, remoteRows: [], order: ["tmdb:1"] });
  assert.equal(merged.lista.length, 0);
  assert.equal(merged.toUpsert[0].borrado, true);
});

test("planLocal conserva el actualizado_en del front y no reescribe borrados ya hechos", () => {
  const editado = planLocalRows({
    lista: [item({ notas: "edit", actualizado_en: T1 })],
    cache: [item({ notas: "viejo", actualizado_en: T0, borrado: false })],
    now: T3,
  });
  assert.equal(editado[0].actualizado_en, T1);
  assert.equal(editado[0].notas, "edit");

  const igual = planLocalRows({
    lista: [item({ notas: "igual", anadido_en: T0 })],
    cache: [item({ notas: "igual", anadido_en: T0, actualizado_en: T1, borrado: false })],
    now: T3,
  });
  assert.equal(igual[0].actualizado_en, T1);
  assert.equal(igual[0].borrado, false);

  const yaBorrado = planLocalRows({
    lista: [],
    cache: [item({ borrado: true, actualizado_en: T1 })],
    now: T3,
  });
  assert.equal(yaBorrado[0].borrado, true);
  assert.equal(yaBorrado[0].actualizado_en, T1);
});

test("un id que solo está en la nube no se convierte en tombstone", () => {
  const merged = fusion(
    [item({ id: "tmdb:1", actualizado_en: T1 })],
    [
      item({ id: "tmdb:1", actualizado_en: T1, borrado: false }),
      item({ id: "tmdb:2", notas: "solo nube", actualizado_en: T2, borrado: false }),
    ],
  );
  assert.deepEqual(merged.lista.map((row) => row.id), ["tmdb:1", "tmdb:2"]);
  assert.equal(merged.toUpsert.length, 0);
  assert.equal(merged.lista[1].notas, "solo nube");
});

test("la fusión no renombra campos ni deja user_id o borrado en la lista", () => {
  const merged = fusion(
    [item({ actualizado_en: T1, temporada: 2, plataformas: [{ nombre: "Filmin", verificacion: "verificado" }] })],
    [],
  );
  assert.deepEqual(Object.keys(merged.lista[0]).sort(), [
    "actualizado_en",
    "anadido_en",
    "estado",
    "favorita",
    "id",
    "notas",
    "plataformas",
    "puntuacion",
    "temporada",
    "visto_en",
  ]);
  const conDueno = mergeUserTitles({
    localRows: [],
    remoteRows: [item({ actualizado_en: T1, borrado: false, user_id: "usuario-secreto", notas: "mías" })],
    order: [],
  });
  assert.equal(conDueno.lista[0].notas, "mías");
  assert.equal("user_id" in conDueno.lista[0], false);
  assert.equal("borrado" in conDueno.lista[0], false);
});

test("visto legado se guarda como vista y el orden local se mantiene", () => {
  const [row] = planLocalRows({
    lista: [item({ estado: "visto", actualizado_en: T1 })],
    cache: [],
    now: T1,
  });
  assert.equal(row.estado, "vista");

  const merged = mergeUserTitles({
    localRows: [
      item({ id: "tmdb:2", actualizado_en: T1, borrado: false }),
      item({ id: "tmdb:1", actualizado_en: T1, borrado: false }),
    ],
    remoteRows: [item({ id: "tmdb:3", actualizado_en: T2, borrado: false, notas: "nueva" })],
    order: ["tmdb:2", "tmdb:1"],
  });
  assert.deepEqual(merged.lista.map((entry) => entry.id), ["tmdb:2", "tmdb:1", "tmdb:3"]);
});

test("no muta las filas de entrada", () => {
  const lista = [item({ notas: "local", actualizado_en: T3 })];
  const remote = [item({ notas: "nube", actualizado_en: T1, borrado: false })];
  const antesLista = JSON.stringify(lista);
  const antesNube = JSON.stringify(remote);
  fusion(lista, remote);
  assert.equal(JSON.stringify(lista), antesLista);
  assert.equal(JSON.stringify(remote), antesNube);
});

test("la única traducción de nombre es misPlataformas ↔ plataformas_contratadas", () => {
  const cloud = prefsLocalACloud(
    ["Netflix", "Otra", "max amazon channel", "Netflix", "Movistar Plus+ Ficción Total"],
    T2,
  );
  assert.deepEqual(Object.keys(cloud).sort(), ["actualizado_en", "plataformas_contratadas"]);
  assert.deepEqual(cloud.plataformas_contratadas, ["Netflix", "Max", "Movistar Plus+"]);
  assert.equal("misPlataformas" in cloud, false);

  const local = prefsCloudALocal(cloud);
  assert.deepEqual(local.misPlataformas, ["Netflix", "Max", "Movistar Plus+"]);
  assert.equal("plataformas_contratadas" in local, false);
  assert.deepEqual(canonicalPlataformas(["Prime Video", "prime video"]), ["Prime Video"]);
});

test("un array vacío de plataformas es un vaciado; la clave ausente no", () => {
  const vacio = planLocalPrefs(
    [],
    { misPlataformas: ["Netflix"], actualizado_en: T1 },
    T3,
  );
  assert.deepEqual(vacio.plataformas_contratadas, []);
  assert.equal(vacio.actualizado_en, T3);
  const ganaVacio = mergePrefs({
    local: vacio,
    remote: { plataformas_contratadas: ["Netflix"], actualizado_en: T2 },
  });
  assert.equal(ganaVacio.push, true);
  assert.deepEqual(ganaVacio.misPlataformas, []);

  assert.equal(planLocalPrefs(undefined, null, T3), null);
  const conserva = mergePrefs({
    local: null,
    remote: { plataformas_contratadas: ["Filmin"], actualizado_en: T2 },
  });
  assert.equal(conserva.push, false);
  assert.deepEqual(conserva.misPlataformas, ["Filmin"]);

  const nubeMasNueva = mergePrefs({
    local: prefsLocalACloud(["Netflix"], T1),
    remote: { plataformas_contratadas: ["Netflix", "Filmin"], actualizado_en: T2 },
  });
  assert.equal(nubeMasNueva.push, false);
  assert.deepEqual(nubeMasNueva.misPlataformas, ["Netflix", "Filmin"]);
});

test("las fichas de catálogo no se suben; un título de usuario sí", () => {
  const rows = planCustom({
    "tmdb:550": { id: "tmdb:550", titulo: "El club de la lucha", sinopsis: "catálogo" },
    "local:11111111-1111-4111-8111-111111111111": { titulo: "Apunte", notas: "no en la ficha" },
  }, [], T3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "local:11111111-1111-4111-8111-111111111111");
  assert.equal(rows[0].origen, "usuario");
  assert.equal(rows[0].ficha.notas, undefined);
  assert.equal(rows[0].ficha.titulo, "Apunte");
});

test("la verificación de streaming no pisa la ficha ni al revés", () => {
  const local = [{
    id: "tmdb:9",
    ficha: { titulo: "Editado", sinopsis: "mía", notas: "secreta" },
    origen: "usuario",
    actualizado_en: T3,
    streaming_es: [],
    verificado_en: null,
  }];
  const remote = [{
    id: "tmdb:9",
    ficha: { titulo: "Original", sinopsis: "suya" },
    origen: "usuario",
    actualizado_en: T1,
    streaming_es: [{ plataforma: "Netflix", tipo: "subscription" }],
    verificado_en: T2,
    user_id: "no-salir",
  }];
  const out = mergeCustomTitles({ localRows: local, remoteRows: remote });
  assert.equal(out.fichas[0].titulo, "Editado");
  assert.equal(out.fichas[0].sinopsis, "mía");
  assert.equal(out.fichas[0].notas, undefined);
  assert.deepEqual(out.fichas[0].streaming_es, remote[0].streaming_es);
  assert.equal(out.fichas[0].verificado_en, T2);
  assert.deepEqual(Object.keys(out.toUpsert[0]).sort(), ["actualizado_en", "ficha", "id", "origen"]);
  assert.equal("streaming_es" in out.toUpsert[0], false);
  assert.equal("verificado_en" in out.toUpsert[0], false);
  assert.equal("user_id" in out.toUpsert[0], false);

  const repetido = planCustom(
    { "tmdb:9": { titulo: "Editado", origen: "usuario" } },
    [{ id: "tmdb:9", ficha: { origen: "usuario", titulo: "Editado", id: "tmdb:9" }, actualizado_en: T1, origen: "usuario" }],
    T3,
  );
  assert.equal(repetido[0].actualizado_en, T1);
});

test("la cola de verificación solo devuelve id y titulo, deduplicados", () => {
  const salida = proyectarPendientes([
    { id: "tmdb:2", user_id: "bbb", notas: "privada", ficha: { titulo: "Alien", sinopsis: "no" }, verificado_en: null },
    { id: "tmdb:1", user_id: "aaa", notas: "secreto", ficha: { titulo: "", sinopsis: "tampoco" }, verificado_en: null },
    { id: "tmdb:1", user_id: "ccc", notas: "otra", titulo: "Dune", verificado_en: null },
    { id: "tmdb:3", user_id: "aaa", notas: "ya", ficha: { titulo: "Ya visto" }, verificado_en: T1 },
  ]);
  assert.deepEqual(salida, [
    { id: "tmdb:1", titulo: "Dune" },
    { id: "tmdb:2", titulo: "Alien" },
  ]);
  const texto = JSON.stringify(salida);
  assert.equal(texto.includes("secreto"), false);
  assert.equal(texto.includes("privada"), false);
  assert.equal(texto.includes("aaa"), false);
  assert.equal(texto.includes("user_id"), false);
  assert.equal(texto.includes("sinopsis"), false);
});

test("cachés separadas por usuario y la cuenta activa decide si se fusiona", () => {
  const a = cacheKey("11111111-1111-4111-8111-111111111111", "titles");
  const b = cacheKey("22222222-2222-4222-8222-222222222222", "titles");
  assert.notEqual(a, b);
  assert.equal(a.includes("22222222"), false);
  assert.equal(b.includes("11111111"), false);
  assert.equal(a.startsWith("cine-web:v2"), false);
  assert.equal(cacheKey("11111111-1111-4111-8111-111111111111", "prefs").endsWith(":prefs"), true);
  assert.throws(() => cacheKey("", "titles"));
  assert.throws(() => cacheKey("user:con:colon", "titles"));

  assert.equal(syncMode({ activeUserId: null, userId: "" }), "omitir");
  assert.equal(syncMode({ activeUserId: null, userId: "a" }), "fusionar");
  assert.equal(syncMode({ activeUserId: "a", userId: "a" }), "fusionar");
  assert.equal(syncMode({ activeUserId: "a", userId: "b" }), "adoptar-nube");
});

test("el esquema usa los nombres del front y la verificación no proyecta datos personales", () => {
  const sql = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  assert.match(sql, /constraint user_titles_estado_chk check \(estado in \('pendiente', 'vista'\)\)/);
  assert.match(sql, /user_id = auth\.uid\(\)/);
  assert.match(sql, /plataformas_contratadas text\[\]/);
  assert.doesNotMatch(sql, /misPlataformas\s+text/);
  assert.equal(sql.includes("updated_at"), false);

  const listar = cuerpo(sql, "listar_verificacion_pendiente");
  assert.match(listar, /ficha->>'titulo'/);
  assert.match(listar, /group by t\.id/);
  assert.equal(listar.includes("user_id"), false);
  assert.equal(listar.includes("notas"), false);

  const aplicar = cuerpo(sql, "aplicar_verificacion");
  assert.match(aplicar, /set streaming_es = p_streaming_es/);
  assert.match(aplicar, /verificado_en = p_verificado_en/);
  assert.match(aplicar, /where id = p_id/);
  assert.equal(aplicar.includes("user_id"), false);
  assert.equal(aplicar.includes("notas"), false);
  assert.equal(aplicar.includes("ficha"), false);

  const pendientes = readFileSync(new URL("./supabase/functions/verificacion-pendientes/index.ts", import.meta.url), "utf8");
  assert.match(pendientes, /listar_verificacion_pendiente/);
  assert.match(pendientes, /id: String\(row\.id \?\? ""\)/);
  assert.match(pendientes, /titulo: String\(row\.titulo \?\? ""\)/);
  assert.doesNotMatch(pendientes, /\.\.\.row/);

  const verificar = readFileSync(new URL("./supabase/functions/verificacion/index.ts", import.meta.url), "utf8");
  assert.match(verificar, /aplicar_verificacion/);
  assert.match(verificar, /p_streaming_es: item\.streaming_es/);
  assert.match(verificar, /p_verificado_en: item\.verificado_en/);
  assert.match(verificar, /ok: true, actualizados/);
  assert.doesNotMatch(verificar, /\.select\(/);

  const tmdb = readFileSync(new URL("./supabase/functions/tmdb-search/index.ts", import.meta.url), "utf8");
  assert.match(tmdb, /language", "es-ES"/);
  assert.match(tmdb, /getUser\(/);
  assert.match(tmdb, /TMDB_API_KEY/);
});

function cuerpo(sql, nombre) {
  const marker = `function public.${nombre}`;
  const start = sql.indexOf(marker);
  const as = sql.indexOf("as $$", start);
  const end = sql.indexOf("$$;", as);
  assert.ok(start >= 0 && as > start && end > as, nombre);
  return sql.slice(as + 4, end);
}
