import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

export const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

export const safeInsert = async (table, data) => {
  if (!supabase) {
    console.warn('Supabase not configured, skipping insert to', table);
    return;
  }
  try {
    const { error } = await supabase.from(table).insert([data]);
    if (error) {
      console.error('Supabase Insert Error:', error);
    }
  } catch (err) {
    console.error('Failed to insert into Supabase:', err);
  }
}
