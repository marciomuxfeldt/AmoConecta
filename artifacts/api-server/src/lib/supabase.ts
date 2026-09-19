import { ReplitConnectors } from "@replit/connectors-sdk";
import { createClient } from "@supabase/supabase-js";

const connectors = new ReplitConnectors();

export function supabaseAdminClient() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórias para listar campanhas.",
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

type SupabaseProxyOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export function supabaseProxy(
  path: string,
  init?: SupabaseProxyOptions,
): Promise<Response> {
  return connectors.proxy("supabase", path, init);
}