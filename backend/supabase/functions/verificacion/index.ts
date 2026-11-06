import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { empty, json, tokenVerificacionOk } from "../_shared/http.ts";

const ID_OK = /^(tmdb:[0-9]+|local:[0-9a-fA-F-]{36}|t_[a-z0-9]+)$/;

/**
 * POST [{id, streaming_es, verificado_en}].
 * Actualiza streaming_es y verificado_en en todas las filas con ese id.
 * La respuesta es solo el recuento: ningún dato personal.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return empty(req);
  if (req.method !== "POST") return json(req, { error: "Método no permitido" }, 405);
  if (!tokenVerificacionOk(req)) return json(req, { error: "No autorizado" }, 401);

  const body = await req.json().catch(() => null);
  if (!Array.isArray(body)) {
    return json(req, { error: "Se espera un array [{id, streaming_es, verificado_en}]" }, 400);
  }
  if (body.length > 200) return json(req, { error: "Demasiados elementos" }, 400);

  for (const item of body) {
    if (!item || typeof item !== "object") return json(req, { error: "Elemento no válido" }, 400);
    if (typeof item.id !== "string" || !ID_OK.test(item.id)) {
      return json(req, { error: "id no válido" }, 400);
    }
    if (!Array.isArray(item.streaming_es)) {
      return json(req, { error: "streaming_es debe ser un array" }, 400);
    }
    if (typeof item.verificado_en !== "string" || Number.isNaN(Date.parse(item.verificado_en))) {
      return json(req, { error: "verificado_en no válido" }, 400);
    }
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  let actualizados = 0;
  for (const item of body) {
    const { data, error } = await admin.rpc("aplicar_verificacion", {
      p_id: item.id,
      p_streaming_es: item.streaming_es,
      p_verificado_en: item.verificado_en,
    });
    if (error) return json(req, { error: "No se pudo actualizar" }, 500);
    actualizados += Number(data) || 0;
  }

  return json(req, { ok: true, actualizados });
});
