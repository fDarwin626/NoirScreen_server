const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// ── Security helpers ──────────────────────────────────────────────────────

// Validate that a user ID is a valid UUID format
// Prevents SQL injection and malformed requests
function isValidUUID(str) {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

// Validate video hash is a valid SHA256 hex string
function isValidHash(str) {
  return /^[0-9a-f]{16,64}$/i.test(str);
}

// ── GET /api/rooms/scheduled/:userId ─────────────────────────────────────
// Returns all active and upcoming scheduled rooms for a user
// Excludes completed and cancelled rooms
router.get('/scheduled/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Security: validate userId format
    if (!isValidUUID(userId)) {
      return res.status(400).json({ error: 'Invalid user ID format' });
    }

const query = `
      SELECT sr.*,
             r.status as room_status,
             -- Use rooms.status as the source of truth for active state
             -- scheduled_rooms.status lags behind rooms.status
             CASE WHEN r.status = 'active' THEN 'active' 
                  ELSE sr.status 
             END as status
      FROM scheduled_rooms sr
      JOIN rooms r ON sr.room_id = r.room_id
      WHERE sr.host_id = $1
        AND sr.status NOT IN ('completed', 'cancelled')
        AND sr.link_expires_at > NOW()
      ORDER BY sr.scheduled_at ASC
    `;
    const result = await pool.query(query, [userId]);

    // ── FIX: serialize all timestamps as UTC ISO strings with Z suffix ──
    // pg returns TIMESTAMPTZ as JS Date objects — JSON.stringify them
    // explicitly so Flutter receives "2024-01-01T08:24:00.000Z" not a
    // locale string that has no timezone info
    const rooms = result.rows.map(row => ({
      ...row,
      scheduled_at:   row.scheduled_at   ? new Date(row.scheduled_at).toISOString()   : null,
      created_at:     row.created_at     ? new Date(row.created_at).toISOString()     : null,
      link_expires_at: row.link_expires_at ? new Date(row.link_expires_at).toISOString() : null,
    }));

    res.json({ rooms });
  } catch (error) {
    console.error('Get scheduled rooms error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/rooms/create ────────────────────────────────────────────────
// Creates a new scheduled room and generates a shareable link
router.post('/create', async (req, res) => {
  try {
    const {
      host_id,
      video_hash,
      video_title,
      video_thumbnail_path,
      stream_type,
      scheduled_at,
      video_duration,
    } = req.body;

    // Security: validate all inputs
    if (!host_id || !video_hash || !video_title || !stream_type || !scheduled_at) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!isValidUUID(host_id)) {
      return res.status(400).json({ error: 'Invalid host ID' });
    }

    if (!isValidHash(video_hash)) {
      return res.status(400).json({ error: 'Invalid video hash' });
    }

    // Sanitize title — strip any HTML or script tags
    const sanitizedTitle = video_title
      .replace(/<[^>]*>/g, '')
      .trim()
      .substring(0, 100);

    if (sanitizedTitle.length === 0) {
      return res.status(400).json({ error: 'Invalid video title' });
    }

    // Validate stream type is one of our allowed types
    const allowedStreamTypes = ['hls', 'sync', 'audio', 'download'];
    if (!allowedStreamTypes.includes(stream_type)) {
      return res.status(400).json({ error: 'Invalid stream type' });
    }

    // Validate scheduled time
    const scheduledDate = new Date(scheduled_at);
    const now = new Date();
    const minTime = new Date(now.getTime() + 2 * 60 * 1000); // 2 min from now
    const maxTime = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000); // 5 days

    if (scheduledDate < minTime) {
      return res.status(400).json({
        error: 'Room must be scheduled at least 2 minutes from now',
      });
    }

    if (scheduledDate > maxTime) {
      return res.status(400).json({
        error: 'Room cannot be scheduled more than 5 days in advance',
      });
    }

    // Verify host exists
    const hostCheck = await pool.query(
      'SELECT user_id FROM users WHERE user_id = $1',
      [host_id]
    );

    if (hostCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Host user not found' });
    }

    
// Limit: max 3 active/scheduled rooms per user at a time
    const roomCount = await pool.query(
      `SELECT COUNT(*) FROM scheduled_rooms
       WHERE host_id = $1
         AND status NOT IN ('cancelled', 'completed')
         AND link_expires_at > NOW()`,
      [host_id]
    );

    if (parseInt(roomCount.rows[0].count) >= 3) {
      return res.status(400).json({
        error: 'You can only have 3 active rooms at a time. Cancel one before creating another.',
      });
    }

    // Conflict check: no two rooms within 10 minutes of each other
    const conflictCheck = await pool.query(
      `SELECT schedule_id FROM scheduled_rooms
       WHERE host_id = $1
         AND status NOT IN ('cancelled', 'completed')
         AND ABS(EXTRACT(EPOCH FROM (scheduled_at - $2::timestamptz))) < 600`,
      [host_id, scheduledDate]
    );

    if (conflictCheck.rows.length > 0) {
      return res.status(400).json({
        error: 'You already have a room scheduled within 10 minutes of this time.',
      });
    }

    // Generate IDs
    const roomId = uuidv4();
    const scheduleId = uuidv4();

    // Generate shareable link
    // Format: noirscreen://room/ROOM_ID
    // This is handled by app_links deep link handler in Flutter
    const shareableLink = `noirscreen://room/${roomId}`;

    // Link expires 24 hours after scheduled time
    const linkExpiresAt = new Date(
      scheduledDate.getTime() + 24 * 60 * 60 * 1000
    );

    // Create room in transaction
    // Both room and scheduled_room must be created or neither
    await pool.query('BEGIN');

    try {
      // Insert into rooms table
      await pool.query(
        `INSERT INTO rooms (
          room_id, host_id, title, type, comm_mode,
          invitation_type, stream_type, scheduled_time,
          status, video_hash, file_name, duration,
          created_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13)`,
        [
          roomId,
          host_id,
          sanitizedTitle,
          'watch_party',
          stream_type === 'audio' ? 'audio' : 'video',
          'link',
          stream_type,
          scheduledDate,        // ✅ always used the parsed Date object
          'waiting',
          video_hash,
          sanitizedTitle,
          video_duration || 0,
          linkExpiresAt,
        ]
      );

      // Insert into scheduled_rooms table
      // ── FIX: use scheduledDate (parsed Date object) not raw scheduled_at
      // string. The raw string from Flutter has no Z suffix so Postgres
      // cannot tell if it is UTC or local — using the Date object is always UTC.
      await pool.query(
        `INSERT INTO scheduled_rooms 
           (schedule_id, room_id, host_id, video_hash, video_title,
            video_file_path, stream_type, scheduled_at, status, 
            shareable_link, link_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          scheduleId,
          roomId,
          host_id,
          video_hash,
          video_title,
          req.body.video_file_path || null,
          stream_type,
          scheduledDate,        // ✅ FIX: was `scheduled_at` (raw string), now the parsed Date object
          'scheduled',
          shareableLink,
          linkExpiresAt,
        ]
      );

      await pool.query('COMMIT');

      // Return the created room with timestamps explicitly as UTC ISO strings
      const result = await pool.query(
        'SELECT * FROM scheduled_rooms WHERE schedule_id = $1',
        [scheduleId]
      );

      const room = result.rows[0];

      // ── FIX: serialize timestamps as UTC ISO strings with Z suffix ──
      // This guarantees Flutter's DateTime.parse gets a timezone-aware
      // string ("2024-01-01T08:24:00.000Z") so .toLocal() works correctly
      const serializedRoom = {
        ...room,
        scheduled_at:    new Date(room.scheduled_at).toISOString(),
        created_at:      new Date(room.created_at).toISOString(),
        link_expires_at: new Date(room.link_expires_at).toISOString(),
      };

      res.status(201).json({
        message: 'Room created successfully',
        room: serializedRoom,
      });
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  } catch (error) {
    console.error('Create room error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/rooms/:roomId/cancel ──────────────────────────────────────
// Cancels a scheduled room — only host can cancel
router.patch('/:roomId/cancel', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { host_id } = req.body;

    // Security: validate inputs
    if (!isValidUUID(roomId) || !isValidUUID(host_id)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    // Verify the requester is actually the host
    // This prevents anyone from cancelling someone else's room
    const roomCheck = await pool.query(
      'SELECT host_id, status FROM rooms WHERE room_id = $1',
      [roomId]
    );

    if (roomCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }

    if (roomCheck.rows[0].host_id !== host_id) {
      return res.status(403).json({
        error: 'Only the room host can cancel this room',
      });
    }

    if (roomCheck.rows[0].status === 'completed') {
      return res.status(400).json({
        error: 'Cannot cancel a completed room',
      });
    }

    // Cancel both room and scheduled_room in transaction
    await pool.query('BEGIN');

    try {
      await pool.query(
        "UPDATE rooms SET status = 'cancelled' WHERE room_id = $1",
        [roomId]
      );

      await pool.query(
        "UPDATE scheduled_rooms SET status = 'cancelled' WHERE room_id = $1",
        [roomId]
      );

      await pool.query('COMMIT');

      res.json({ message: 'Room cancelled successfully' });
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  } catch (error) {
    console.error('Cancel room error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/rooms/join ──────────────────────────────────────────────────
// Validates a shareable link and returns room data if valid
router.post('/join', async (req, res) => {
  try {
    const { link } = req.body;

    // Security: validate link format
    if (!link || typeof link !== 'string') {
      return res.status(400).json({ error: 'Invalid link' });
    }

    // Extract room ID from link
    const prefix = 'noirscreen://room/';
    if (!link.startsWith(prefix)) {
      return res.status(400).json({ error: 'Invalid link format' });
    }

    const roomId = link.substring(prefix.length);

    if (!isValidUUID(roomId)) {
      return res.status(400).json({ error: 'Invalid room ID in link' });
    }

    // Get room details
    const result = await pool.query(
      `SELECT sr.*, r.status as room_status, r.playback_position, r.is_playing
       FROM scheduled_rooms sr
       JOIN rooms r ON sr.room_id = r.room_id
       WHERE sr.room_id = $1
         AND sr.link_expires_at > NOW()
         AND sr.status NOT IN ('cancelled', 'completed')`,
      [roomId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Room not found or link has expired',
      });
    }

    const room = result.rows[0];

    // ── FIX: serialize timestamps as UTC ISO strings with Z suffix ──
    const serializedRoom = {
      ...room,
      scheduled_at:    new Date(room.scheduled_at).toISOString(),
      created_at:      new Date(room.created_at).toISOString(),
      link_expires_at: new Date(room.link_expires_at).toISOString(),
    };

    res.json({ room: serializedRoom });
  } catch (error) {
    console.error('Join room error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


router.get('/completed/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isValidUUID(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const result = await pool.query(
      `SELECT * FROM scheduled_rooms
       WHERE host_id = $1
         AND status = 'completed'
       ORDER BY scheduled_at DESC
       LIMIT 1`,
      [userId]
    );

    // ── FIX: serialize timestamps as UTC ISO strings with Z suffix ──
    const rooms = result.rows.map(row => ({
      ...row,
      scheduled_at:    row.scheduled_at    ? new Date(row.scheduled_at).toISOString()    : null,
      created_at:      row.created_at      ? new Date(row.created_at).toISOString()      : null,
      link_expires_at: row.link_expires_at ? new Date(row.link_expires_at).toISOString() : null,
    }));

    res.json({ rooms });
  } catch (e) {
    console.error('Get completed rooms error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;