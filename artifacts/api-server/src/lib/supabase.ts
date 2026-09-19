import { ReplitConnectors } from "@replit/connectors-sdk";

const connectors = new ReplitConnectors();

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