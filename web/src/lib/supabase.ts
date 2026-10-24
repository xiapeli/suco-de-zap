import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sucoEnv } from './suco-env.ts';

// Any valid Supabase project URL passes the shape check — the deployer pins
// their own project via VITE_SUPABASE_URL (no hardcoded project binding).
const SUPABASE_URL_PATTERN = /^https:\/\/[a-z0-9][a-z0-9-]{19,30}\.supabase\.co$/;
let client: SupabaseClient | null | undefined;

export function getSucoSupabase(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = sucoEnv.VITE_SUPABASE_URL;
  const key = sucoEnv.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL_PATTERN.test(url || '') || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key || '')) {
    client = null;
    return client;
  }
  client = createClient(url, key, {
    auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
  });
  return client;
}
