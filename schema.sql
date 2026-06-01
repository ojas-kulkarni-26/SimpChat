  -- Run this in your Supabase project SQL editor

  -- Enable replication for realtime subscriptions
  ALTER PUBLICATION supabase_realtime ADD TABLE messages;
  ALTER PUBLICATION supabase_realtime ADD TABLE presence;
  ALTER PUBLICATION supabase_realtime ADD TABLE read_state;

  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    sender TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    msg_type TEXT NOT NULL DEFAULT 'text',
    reply_to INTEGER,
    reactions JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at TIMESTAMPTZ,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
  );

  CREATE TABLE IF NOT EXISTS presence (
    name TEXT PRIMARY KEY,
    is_online BOOLEAN NOT NULL DEFAULT FALSE,
    is_typing BOOLEAN NOT NULL DEFAULT FALSE,
    last_seen TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS read_state (
    name TEXT PRIMARY KEY,
    last_read_id INTEGER NOT NULL DEFAULT 0
  );

  -- Permissive RLS: same security model as having the Turso token in the browser
  ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE presence ENABLE ROW LEVEL SECURITY;
  ALTER TABLE read_state ENABLE ROW LEVEL SECURITY;

  CREATE POLICY "allow_all" ON messages FOR ALL USING (true) WITH CHECK (true);
  CREATE POLICY "allow_all" ON presence FOR ALL USING (true) WITH CHECK (true);
  CREATE POLICY "allow_all" ON read_state FOR ALL USING (true) WITH CHECK (true);
