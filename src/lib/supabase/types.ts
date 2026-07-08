import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/** A Supabase client typed against our generated database schema. */
export type DbClient = SupabaseClient<Database>;
