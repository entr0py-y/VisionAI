const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// OPTIMIZED: Fire-and-forget insert — no await, non-blocking
// User response is sent immediately, DB write happens in background
const safeInsert = (table, data) => {
  if (!supabase) {
    console.warn('Supabase not configured, skipping insert to', table);
    return Promise.resolve();
  }
  // Non-blocking: start the insert but don't wait for it
  supabase.from(table).insert([data])
    .then(({ error }) => {
      if (error) console.error('Supabase Insert Error:', error);
    })
    .catch(err => {
      console.error('Failed to insert into Supabase:', err);
    });
  return Promise.resolve(); // Return immediately
};

module.exports = { supabase, safeInsert };
