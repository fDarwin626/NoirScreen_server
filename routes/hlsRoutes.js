// backend/routes/hlsRoutes.js
//
// Handles all HLS video streaming endpoints:
//   POST   /:roomId/chunk                 — owner uploads a chunk
//   GET    /:roomId/stream.m3u8           — viewers load the playlist
//   GET    /:roomId/chunks/:chunkName     — viewers download chunk files
//   DELETE /:roomId/chunks/before/:index  — rolling window cleanup
//   DELETE /:roomId/chunks/all            — full cleanup on room end
//   GET    /:roomId/position              — chunker asks where playback is
//
// Mount in index.js with:
//   const hlsRoutes = require('./routes/hlsRoutes');
//   app.use('/api/rooms', hlsRoutes);

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const pool     = require('../config/database');

// ── UUID validator ────────────────────────────────────────────────────────────
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Multer storage — saves chunks to backend/uploads/hls/{roomId}/ ────────────
const hlsStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { roomId } = req.params;

    // Security: validate roomId is a UUID before using as folder name
    // Prevents directory traversal attacks
    if (!UUID_REGEX.test(roomId)) {
      return cb(new Error('Invalid room ID'), '');
    }

    const dir = path.join(__dirname, '../uploads/hls', roomId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Security: only allow .ts chunk files
    if (!file.originalname.match(/^chunk_\d{5}\.ts$/)) {
      return cb(new Error('Invalid chunk filename'), '');
    }
    cb(null, file.originalname);
  },
});

const upload = multer({
  storage: hlsStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max per chunk
  fileFilter: (req, file, cb) => {
    // Extra check: only .ts MIME type or octet-stream
    if (file.mimetype !== 'video/mp2t' &&
        file.mimetype !== 'application/octet-stream') {
      return cb(new Error('Invalid file type'), false);
    }
    cb(null, true);
  },
});

// ── POST /:roomId/chunk ───────────────────────────────────────────────────────
// Owner's phone uploads one .ts chunk
// Body: { chunkIndex: number }
// File: multipart field named 'chunk'
router.post('/:roomId/chunk', upload.single('chunk'), async (req, res) => {
  try {
    const { roomId } = req.params;
    const chunkIndex = parseInt(req.body.chunkIndex);

    if (!req.file) {
      return res.status(400).json({ error: 'No chunk file received' });
    }
    if (!UUID_REGEX.test(roomId)) {
      return res.status(400).json({ error: 'Invalid room ID' });
    }
    if (isNaN(chunkIndex) || chunkIndex < 0) {
      return res.status(400).json({ error: 'Invalid chunk index' });
    }

    // Record in database for lifecycle tracking and cleanup
    await pool.query(
      `INSERT INTO stream_chunks
         (chunk_id, room_id, chunk_index, file_path, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [roomId, chunkIndex, req.file.path]
    );

    // Rebuild the .m3u8 playlist including this new chunk
    await _generatePlaylist(roomId);

    console.log(`📦 CHUNK: room ${roomId} chunk ${chunkIndex} received`);
    res.json({ success: true, chunkIndex });
  } catch (e) {
    console.error('POST chunk error:', e);
    res.status(500).json({ error: 'Failed to store chunk' });
  }
});

// ── GET /:roomId/stream.m3u8 ──────────────────────────────────────────────────
// Viewers load this URL into their HLS video player.
// It is a plain text file listing all available chunk URLs.
router.get('/:roomId/stream.m3u8', async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!UUID_REGEX.test(roomId)) {
      return res.status(400).json({ error: 'Invalid room ID' });
    }

    const playlistPath = path.join(
      __dirname, '../uploads/hls', roomId, 'stream.m3u8'
    );

    if (!fs.existsSync(playlistPath)) {
      return res.status(404).json({ error: 'Stream not ready yet' });
    }

    // No-cache header so viewers always get the latest playlist
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.sendFile(playlistPath);
  } catch (e) {
    console.error('GET playlist error:', e);
    res.status(500).json({ error: 'Failed to serve playlist' });
  }
});

// ── GET /:roomId/chunks/:chunkName ────────────────────────────────────────────
// Viewers download individual .ts segment files.
// Called automatically by the HLS player when it reads the playlist.
router.get('/:roomId/chunks/:chunkName', (req, res) => {
  const { roomId, chunkName } = req.params;

  // Security: strict validation — only allow chunk_NNNNN.ts format
  // Prevents path traversal like ../../etc/passwd
  if (!UUID_REGEX.test(roomId)) {
    return res.status(400).json({ error: 'Invalid room ID' });
  }
  if (!chunkName.match(/^chunk_\d{5}\.ts$/)) {
    return res.status(400).json({ error: 'Invalid chunk name' });
  }

  const chunkPath = path.join(
    __dirname, '../uploads/hls', roomId, chunkName
  );

  if (!fs.existsSync(chunkPath)) {
    return res.status(404).json({ error: 'Chunk not found' });
  }

  res.setHeader('Content-Type', 'video/mp2t');
  res.sendFile(chunkPath);
});

// ── DELETE /:roomId/chunks/before/:index ──────────────────────────────────────
// Called by the owner's phone every 10 seconds.
// Deletes all chunks with index <= the given value.
// This is the rolling window — keeps server storage minimal.
// At any moment the server holds at most ~20 chunks (~60s) per room.
router.delete('/:roomId/chunks/before/:index', async (req, res) => {
  try {
    const { roomId } = req.params;
    const upToIndex = parseInt(req.params.index);

    if (!UUID_REGEX.test(roomId)) {
      return res.status(400).json({ error: 'Invalid room ID' });
    }
    if (isNaN(upToIndex) || upToIndex < 0) {
      return res.status(400).json({ error: 'Invalid index' });
    }

    // Get file paths from DB
    const result = await pool.query(
      `SELECT file_path FROM stream_chunks
       WHERE room_id = $1
         AND chunk_index <= $2
         AND deleted_at IS NULL`,
      [roomId, upToIndex]
    );

    // Delete files from disk
    let deleted = 0;
    for (const row of result.rows) {
      if (fs.existsSync(row.file_path)) {
        fs.unlinkSync(row.file_path);
        deleted++;
      }
    }

    // Mark as deleted in DB
    await pool.query(
      `UPDATE stream_chunks
       SET deleted_at = NOW()
       WHERE room_id = $1 AND chunk_index <= $2`,
      [roomId, upToIndex]
    );

    // Regenerate playlist without the deleted chunks
    await _generatePlaylist(roomId);

    console.log(`🗑️  CHUNKS: Deleted ${deleted} old chunks for room ${roomId}`);
    res.json({ success: true, deleted });
  } catch (e) {
    console.error('DELETE chunks/before error:', e);
    res.status(500).json({ error: 'Failed to delete old chunks' });
  }
});

// ── DELETE /:roomId/chunks/all ────────────────────────────────────────────────
// Called when a room ends (from Flutter stop() or roomSocketHandlers end_room).
// Deletes the entire HLS folder for this room immediately.
router.delete('/:roomId/chunks/all', async (req, res) => {
  try {
    const { roomId } = req.params;

    if (!UUID_REGEX.test(roomId)) {
      return res.status(400).json({ error: 'Invalid room ID' });
    }

    const hlsDir = path.join(__dirname, '../uploads/hls', roomId);

    // Delete entire room folder from disk
    if (fs.existsSync(hlsDir)) {
      fs.rmSync(hlsDir, { recursive: true, force: true });
    }

    // Mark everything as deleted in DB
    await pool.query(
      `UPDATE stream_chunks
       SET deleted_at = NOW()
       WHERE room_id = $1 AND deleted_at IS NULL`,
      [roomId]
    );

    console.log(`🧹 CHUNKS: Full cleanup for room ${roomId}`);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE chunks/all error:', e);
    res.status(500).json({ error: 'Failed to clean up chunks' });
  }
});

// ── GET /:roomId/position ─────────────────────────────────────────────────────
// Called by the Flutter chunker every 10 seconds.
// Returns the current playback position in seconds as plain text.
// Backend knows this because room_play/room_seek socket events update
// the rooms table current_time column.
router.get('/:roomId/position', async (req, res) => {
  try {
    const { roomId } = req.params;

    if (!UUID_REGEX.test(roomId)) {
      return res.status(400).json({ error: 'Invalid room ID' });
    }

    const result = await pool.query(
      'SELECT current_time FROM rooms WHERE room_id = $1',
      [roomId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const position = Math.floor(result.rows[0].current_time || 0);
    res.send(position.toString());
  } catch (e) {
    console.error('GET position error:', e);
    res.status(500).json({ error: 'Failed to get position' });
  }
});
// ── Helper: generate HLS playlist from all active chunks ─────────────────────
// Called after every chunk upload and every deletion.
// Produces a standard .m3u8 file that any HLS player (including
// Flutter's video_player) can load and play.
async function _generatePlaylist(roomId) {
  try {
    const result = await pool.query(
      `SELECT chunk_index FROM stream_chunks
       WHERE room_id = $1 AND deleted_at IS NULL
       ORDER BY chunk_index ASC`,
      [roomId]
    );

    const chunkDuration = 3; // seconds per chunk — must match Flutter side

    let m3u8 = '#EXTM3U\n';
    m3u8 += '#EXT-X-VERSION:3\n';
    m3u8 += `#EXT-X-TARGETDURATION:${chunkDuration}\n`;
    const firstChunkIndex = result.rows.length > 0 ? result.rows[0].chunk_index : 0;
      m3u8 += `#EXT-X-MEDIA-SEQUENCE:${firstChunkIndex}\n`;

    for (const row of result.rows) {
      const idx     = row.chunk_index;
      const padded  = idx.toString().padStart(5, '0');
      const name    = `chunk_${padded}.ts`;
      m3u8 += `#EXTINF:${chunkDuration}.000,\n`;
      // Absolute path so the HLS player knows where to fetch each chunk
      const BASE_URL = process.env.SERVER_BASE_URL || 'https://noirscreen-server.onrender.com';
      m3u8 += `${BASE_URL}/api/rooms/${roomId}/chunks/${name}\n`;

    }

    const playlistPath = path.join(
      __dirname, '../uploads/hls', roomId, 'stream.m3u8'
    );
    fs.writeFileSync(playlistPath, m3u8);
  } catch (e) {
    console.error('_generatePlaylist error:', e);
  }
}

module.exports = router;