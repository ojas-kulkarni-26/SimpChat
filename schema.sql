  -- Run this in your Supabase project SQL editor

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
    mood TEXT NOT NULL DEFAULT '',
    last_seen TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS read_state (
    name TEXT PRIMARY KEY,
    last_read_id INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    name TEXT PRIMARY KEY,
    subscription JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Enable replication for realtime subscriptions
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'messages') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE messages;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'presence') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE presence;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'read_state') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE read_state;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'push_subscriptions') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE push_subscriptions;
    END IF;
  END $$;

  -- Permissive RLS: same security model as having the Turso token in the browser
  ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE presence ENABLE ROW LEVEL SECURITY;
  ALTER TABLE read_state ENABLE ROW LEVEL SECURITY;
  ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "allow_all" ON messages;
  CREATE POLICY "allow_all" ON messages FOR ALL USING (true) WITH CHECK (true);
  DROP POLICY IF EXISTS "allow_all" ON presence;
  CREATE POLICY "allow_all" ON presence FOR ALL USING (true) WITH CHECK (true);
  DROP POLICY IF EXISTS "allow_all" ON read_state;
  CREATE POLICY "allow_all" ON read_state FOR ALL USING (true) WITH CHECK (true);
  DROP POLICY IF EXISTS "allow_all" ON push_subscriptions;
  CREATE POLICY "allow_all" ON push_subscriptions FOR ALL USING (true) WITH CHECK (true);
