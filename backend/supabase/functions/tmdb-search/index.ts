import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { empty, json } from "../_shared/http.ts";

const IMG = "https://image.tmdb.org/t/p";

type TmdbRow = {
  id?: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
};

function mapResult(row: TmdbRow, endpoint: string) {
  const media = row.media_type || (endpoint === "tv" ? "tv" : endpoint === "movie" ? "movie" : "");
  if (media !== "movie" && media !== "tv") return null;
  if (row.id == null) return null;
  const serie = media === "tv";
  const fecha = serie ? row.first_air_date : row.release_date;
  const anio = fecha ? Number(String(fecha).slice(0, 4)) : null;
  return {
    id: `tmdb:${row.id}`,
    tmdb_id: row.id,
    tipo: serie ? "serie" : "pelicula",
    titulo: (serie ? row.name : row.title) || "",
    titulo_original: (serie ? row.original_name : row.original_title) || "",
    anio: anio && !Number.isNaN(anio) ? anio : null,
    sinopsis: row.overview || "",
    poster: row.poster_path ? `${IMG}/w500${row.poster_path}` : "",
    backdrop: row.backdrop_path ? `${IMG}/w1280${row.backdrop_path}` : "",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return empty(req);
  if (req.method !== "GET" && req.method !== "POST") {
    return json(req, { error: "Método no permitido" }, 405);
  }

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json(req, { error: "No autorizado" }, 401);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return json(req, { error: "No autorizado" }, 401);

  const url = new URL(req.url);
  let q = (url.searchParams.get("q") || "").trim();
  let tipo = url.searchParams.get("tipo") || "multi";
  let page = url.searchParams.get("page") || "1";
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    q = String(body.q || body.query || q).trim();
    tipo = String(body.tipo || tipo);
    page = String(body.page || page);
  }
  if (!q) return json(req, { error: "Falta el parámetro q" }, 400);
  if (q.length > 200) return json(req, { error: "Búsqueda demasiado larga" }, 400);

  const endpoint = tipo === "pelicula" ? "movie" : tipo === "serie" ? "tv" : "multi";
  const pageNum = Math.min(500, Math.max(1, Number.parseInt(page, 10) || 1));
  const key = Deno.env.get("TMDB_API_KEY") || "";
  if (!key) return json(req, { error: "TMDB no configurado" }, 500);

  const tmdb = new URL(`https://api.themoviedb.org/3/search/${endpoint}`);
  tmdb.searchParams.set("language", "es-ES");
  tmdb.searchParams.set("region", "ES");
  tmdb.searchParams.set("query", q);
  tmdb.searchParams.set("page", String(pageNum));
  tmdb.searchParams.set("include_adult", "false");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key.startsWith("ey")) headers.Authorization = `Bearer ${key}`;
  else tmdb.searchParams.set("api_key", key);

  const res = await fetch(tmdb, { headers });
  if (!res.ok) return json(req, { error: "TMDB no disponible" }, 502);
  const payload = await res.json();
  const resultados = [];
  for (const row of payload.results || []) {
    const mapped = mapResult(row, endpoint);
    if (mapped) resultados.push(mapped);
  }
  return json(req, {
    resultados,
    pagina: payload.page || pageNum,
    total_paginas: payload.total_pages || 1,
  });
});
