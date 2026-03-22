const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();
const path = require('path'); 
const pool = require('./config/database');

// Auto-run schema on boot — safe to run multiple times (IF NOT EXISTS)
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
      CREATE TABLE IF NOT EXISTS stream_chunks (
        chunk_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID REFERENCES rooms(room_id),
        chunk_index INTEGER,
        file_path TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
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
initSchema();

const app = express();
const server = http.createServer(app);

// Socket.io for WebRTC signaling
const io = socketIo(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',')
      : '*',
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : '*',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Server uploaded files (development only)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


// Test route
app.get('/', (req, res) => {
  res.json({
    message: '🎬 NoirScreen Backend API',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
  });
});

// Health check route
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    database: 'connected',
    uptime: process.uptime(),
  });
});

// Import routes
const userRoutes = require('./routes/userRoutes');
const videoRoutes = require('./routes/videoRoutes');
const roomRoutes = require('./routes/roomRoutes');
const hlsRoutes = require('./routes/hlsRoutes');
// Register routes
app.use('/api/users', userRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/rooms', hlsRoutes);

// Socket.io connection
const { setupRoomHandlers } = require('./roomSocketHandlers');
setupRoomHandlers(io);

// Start server
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Allow external connections

// Hourly cleanup — deletes any HLS chunks older than 2 hours
// This is a safety net for chunks that slipped through
// the rolling window or a crashed room session
setInterval(async () => {
  try {
    const cleanupPool = require('./config/database');
    const fs = require('fs');
    const stale = await cleanupPool.query(
      `SELECT file_path FROM stream_chunks
       WHERE created_at < NOW() - INTERVAL '2 hours'
         AND deleted_at IS NULL`
    );
    for (const row of stale.rows) {
      if (fs.existsSync(row.file_path)) {
        fs.unlinkSync(row.file_path);
      }
    }
    await cleanupPool.query(
      `UPDATE stream_chunks SET deleted_at = NOW()
       WHERE created_at < NOW() - INTERVAL '2 hours'
         AND deleted_at IS NULL`
    );
    if (stale.rows.length > 0) {
      console.log(`🧹 CLEANUP: Removed ${stale.rows.length} stale chunks`);
    }
  } catch (e) {
    console.error('Hourly cleanup error:', e);
  }
}, 60 * 60 * 1000);

// Auto-activate rooms when scheduled time arrives
// Runs every 30 seconds — no manual trigger needed
// Owner video starts playing, viewers can join at current position
setInterval(async () => {
  try {
    const result = await pool.query(
      `UPDATE rooms
       SET status = 'active'
       WHERE status = 'waiting'
         AND scheduled_time <= NOW()
         AND expires_at > NOW()
       RETURNING room_id`
    );

    for (const row of result.rows) {
      await pool.query(
        `UPDATE scheduled_rooms
         SET status = 'active'
         WHERE room_id = $1`,
        [row.room_id]
      );
      console.log(`🟢 ROOM ACTIVATED: ${row.room_id}`);
    }
  } catch (e) {
    console.error('Room activation error:', e);
  }
}, 30 * 1000);

server.listen(PORT, HOST, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎬 NoirScreen Backend Server');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Local: http://localhost:${PORT}`);
  console.log(`📱 Network: http://192.168.0.113:${PORT}`); // Your PC IP
  console.log(`🔌 WebSocket: ws://192.168.0.113:${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
  console.log(`🔓 Listening on: ${HOST} (All interfaces)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});