import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "@/lib/config";

let cached: SupabaseClient | null = null;

export class ConfigError extends Error {}

/** Server-only client using the secret key. Never import this from client code. */
export function db(): SupabaseClient {
  if (cached) return cached;
  const url = SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new ConfigError(
      "The server is missing SUPABASE_SECRET_KEY. Add it in Vercel project settings, then redeploy.",
    );
  }
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}

export const BUCKET = "files";
