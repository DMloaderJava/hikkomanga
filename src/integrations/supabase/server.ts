import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from './config';

export function createServerClient() {
  return createClient(
    isSupabaseConfigured ? SUPABASE_URL : 'https://placeholder.supabase.co',
    isSupabaseConfigured ? SUPABASE_ANON_KEY : 'placeholder-anon-key'
  );
}
