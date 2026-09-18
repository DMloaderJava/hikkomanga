import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from './config';

export { isSupabaseConfigured };

let clientInstance: SupabaseClient | null = null;
let clientPromise: Promise<SupabaseClient> | null = null;

export async function getSupabase(): Promise<SupabaseClient> {
  if (clientInstance) return clientInstance;
  if (!clientPromise) {
    clientPromise = (async () => {
      const { createClient } = await import('@supabase/supabase-js');
      clientInstance = createClient(
        isSupabaseConfigured ? SUPABASE_URL : 'https://placeholder.supabase.co',
        isSupabaseConfigured ? SUPABASE_ANON_KEY : 'placeholder-anon-key'
      );
      return clientInstance;
    })();
  }
  return clientPromise;
}
