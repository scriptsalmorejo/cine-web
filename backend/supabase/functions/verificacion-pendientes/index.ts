import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { empty, json, tokenVerificacionOk } from "../_shared/http.ts";

/**
 * GET. Autorización: header x-verify-token = secreto VERIFY_TOKEN.
 * Respuesta: [{id, titulo}] deduplicado entre usuarios.
 * No devuelve user_id, notas, ficha ni ningún otro dato personal.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return empty(req);
  if (req.method !== "GET") return json(req, { error: "Método no permitido" }, 405);
  if (!tokenVerificacionOk(req)) return json(req, { error: "No autorizado" }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data, error } = await admin.rpc("listar_verificacion_pendiente");
  if (error) return json(req, { error: "No se pudo leer la cola" }, 500);

  const salida = (Array.isArray(data) ? data : []).map((row: { id?: string; titulo?: string }) => ({
    id: String(row.id ?? ""),
    titulo: String(row.titulo ?? ""),
  })).filter((row: { id: string }) => row.id);

  return json(req, salida);
});
