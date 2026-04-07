// index.js
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();
const path = require('path');
const pool = require('./config/database');
const { generalLimiter } = require('./middleware/rateLimiter');
const { runDiscoveryMigration } = require('./config/discoveryMigration');

// ── Schema init ───────────────────────────────────────────────────────────────
async function initSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(50) UNIQUE NOT NULL,
        avatar_type VARCHAR(20) DEFAULT 'default',
        avatar_id INTEGER,
        photo_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_active TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS rooms (
        room_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID REFERENCES users(user_id),
        title VARCHAR(200),
        type VARCHAR(50),
        comm_mode VARCHAR(50),
        invitation_type VARCHAR(50),
        stream_type VARCHAR(20),
        scheduled_time TIMESTAMPTZ,
        status VARCHAR(20) DEFAULT 'waiting',
        video_hash VARCHAR(64),
        file_name VARCHAR(200),
        duration INTEGER DEFAULT 0,
        playback_position INTEGER DEFAULT 0,
        current_time REAL DEFAULT 0,
        is_playing BOOLEAN DEFAULT false,
        is_public BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS scheduled_rooms (
        schedule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID REFERENCES rooms(room_id),
        host_id UUID REFERENCES users(user_id),
        video_hash VARCHAR(64),
        video_title VARCHAR(200),
        video_file_path TEXT,
        video_thumbnail_path TEXT,
        stream_type VARCHAR(20),
        scheduled_at TIMESTAMPTZ,
        status VARCHAR(20) DEFAULT 'scheduled',
        shareable_link TEXT,
        link_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS join_requests (
        request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID,
        requester_id UUID,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ Database schema ready');
  } catch (e) {
    console.error('❌ Schema init error:', e);
  }
}

async function migrateSchema() {
  try {
    await pool.query(`
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS current_time REAL DEFAULT 0;
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS playback_position INTEGER DEFAULT 0;
    `);
    console.log('✅ Schema migration complete');
  } catch (e) {
    console.error('❌ Migration error:', e);
  }
}

// Run all migrations on boot
initSchema().then(() => migrateSchema()).then(() => runDiscoveryMigration());

const app = express();
const server = http.createServer(app);

// ── Socket.io ─────────────────────────────────────────────────────────────────
const io = socketIo(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',')
      : '*',
    methods: ['GET', 'POST'],
  },
});

// Attach io to app so routes can emit events (e.g. discoveryRoutes join-request)
app.set('io', io);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : '*',
  credentials: true,
}));
app.use(express.json({ limit: '5mb' })); // 5mb allows base64 avatar uploads
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  if (req.path === '/health') return next(); // skip health — UptimeRobot pings this
  generalLimiter(req, res, next);
});

// Static files — thumbnails served from /uploads/thumbnails/
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Skip socket upgrade requests — rate limiting HTTP only
app.use((req, res, next) => {
  if (req.headers.upgrade === 'websocket') return next();
  generalLimiter(req, res, next);
});

// ── Routes ────────────────────────────────────────────────────────────────────
const userRoutes = require('./routes/userRoutes');
const videoRoutes = require('./routes/videoRoutes');
const roomRoutes = require('./routes/roomRoutes');
const discoveryRoutes = require('./routes/discoveryRoutes');

app.use('/api/users', userRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/discovery', discoveryRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ message: '🎬 NoirScreen Backend API', version: '1.0.0', status: 'running' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', database: 'connected', uptime: process.uptime() });
});

// ── Socket handlers ───────────────────────────────────────────────────────────
const { setupRoomHandlers } = require('./roomSocketHandlers');
setupRoomHandlers(io);

// ── Intervals ─────────────────────────────────────────────────────────────────

// Auto-activate rooms every 30s
setInterval(async () => {
  try {
    const result = await pool.query(
      `UPDATE rooms SET status = 'active'
       WHERE status = 'waiting'
         AND scheduled_time <= NOW()
         AND expires_at > NOW()
       RETURNING room_id`
    );
    for (const row of result.rows) {
      await pool.query(
        `UPDATE scheduled_rooms SET status = 'active' WHERE room_id = $1`,
        [row.room_id]
      );
      console.log(`🟢 ROOM ACTIVATED: ${row.room_id}`);
    }
  } catch (e) { console.error('Room activation error:', e); }
}, 30 * 1000);

// Account auto-delete — removes users inactive for 90+ days with no active rooms
// Runs once daily
setInterval(async () => {
  try {
    const result = await pool.query(
      `DELETE FROM users
       WHERE created_at < NOW() - INTERVAL '90 days'
         AND user_id NOT IN (
           SELECT DISTINCT host_id FROM rooms
           WHERE status NOT IN ('completed', 'cancelled')
             AND expires_at > NOW()
         )
       RETURNING user_id`
    );
    if (result.rows.length > 0) {
      console.log(`🗑️  AUTO-DELETE: Removed ${result.rows.length} inactive users`);
    }
  } catch (e) { console.error('Auto-delete error:', e); }
}, 24 * 60 * 60 * 1000);

// ── Server ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎬 NoirScreen Backend Server');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`🌍 ENV: ${process.env.NODE_ENV}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});