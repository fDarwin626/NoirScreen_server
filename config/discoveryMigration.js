
const pool = require('./database');

async function runDiscoveryMigration() {
  try {
    await pool.query(`
      -- Server-stored thumbnail for discovery (host uploads local thumb to server)
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

      -- Report count — 1 triggers takedown in testing, 4 in production
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS report_count INTEGER DEFAULT 0;

      -- Join request enhancements — store requester info so host sees
      -- username + avatar in popup without a second DB round-trip
      ALTER TABLE join_requests ADD COLUMN IF NOT EXISTS username TEXT;
      ALTER TABLE join_requests ADD COLUMN IF NOT EXISTS avatar_url TEXT;

      -- Blocked rooms — discovery hidden after report threshold reached
      CREATE TABLE IF NOT EXISTS blocked_rooms (
        block_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id     UUID NOT NULL,
        reason      TEXT DEFAULT 'reported',
        blocked_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- Index public active rooms for fast discovery queries
      CREATE INDEX IF NOT EXISTS idx_rooms_public_active
        ON rooms (is_public, status)
        WHERE is_public = true AND status IN ('waiting', 'active');

      -- Index join_requests by room for fast host lookup
      CREATE INDEX IF NOT EXISTS idx_join_requests_room
        ON join_requests (room_id, status);

      -- Index join_requests by requester so guests can see their own requests
      CREATE INDEX IF NOT EXISTS idx_join_requests_requester
        ON join_requests (requester_id, status);
    `);
    console.log('✅ Discovery migration complete');
  } catch (e) {
    console.error('❌ Discovery migration error:', e);
  }
}

module.exports = { runDiscoveryMigration };