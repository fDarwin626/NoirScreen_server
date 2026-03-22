const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// ── Security helpers ──────────────────────────────────────────────────────

function isValidUUID(str) {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

function isValidHash(str) {
  return /^[0-9a-f]{16,64}$/i.test(str);
}

// ── GET /api/rooms/scheduled/:userId ─────────────────────────────────────
router.get('/scheduled/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!isValidUUID(userId)) {
      return res.status(400).json({ error: 'Invalid user ID format' });
    }

    const query = `
      SELECT sr.*,
             r.status as room_status,
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

    const rooms = result.rows.map(row => ({
      ...row,
      scheduled_at:    row.scheduled_at    ? new Date(row.scheduled_at).toISOString()    : null,
      created_at:      row.created_at      ? new Date(row.created_at).toISOString()      : null,
      link_expires_at: row.link_expires_at ? new Date(row.link_expires_at).toISOString() : null,
    }));

    res.json({ rooms });
  } catch (error) {
    console.error('Get scheduled rooms error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/rooms/create ────────────────────────────────────────────────
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

    if (!host_id || !video_hash || !video_title || !stream_type || !scheduled_at) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!isValidUUID(host_id)) {
      return res.status(400).json({ error: 'Invalid host ID' });
    }

    if (!isValidHash(video_hash)) {
      return res.status(400).json({ error: 'Invalid video hash' });
    }

    const sanitizedTitle = video_title
      .replace(/<[^>]*>/g, '')
      .trim()
      .substring(0, 100);

    if (sanitizedTitle.length === 0) {
      return res.status(400).json({ error: 'Invalid video title' });
    }

    const allowedStreamTypes = ['hls', 'sync', 'audio', 'download'];
    if (!allowedStreamTypes.includes(stream_type)) {
      return res.status(400).json({ error: 'Invalid stream type' });
    }

    const scheduledDate = new Date(scheduled_at);
    const now = new Date();
    const minTime = new Date(now.getTime() + 2 * 60 * 1000);
    const maxTime = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

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

    const hostCheck = await pool.query(
      'SELECT user_id FROM users WHERE user_id = $1',
      [host_id]
    );

    if (hostCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Host user not found' });
    }

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

    const roomId = uuidv4();
    const scheduleId = uuidv4();
    const shareableLink = `noirscreen://room/${roomId}`;
    const linkExpiresAt = new Date(scheduledDate.getTime() + 24 * 60 * 60 * 1000);

    await pool.query('BEGIN');

    try {
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
          scheduledDate,
          'waiting',
          video_hash,
          sanitizedTitle,
          video_duration || 0,
          linkExpiresAt,
        ]
      );

      // ── FIX 1: video_thumbnail_path now included in INSERT ────────────
      // It was missing from the VALUES list before so DB stored NULL always,
      // which is why the thumbnail never appeared on the scheduled room card.
      // ── FIX 2: scheduledDate (Date object) used instead of raw string ─
      // The raw scheduled_at string from Flutter has no Z suffix so Postgres
      // could misinterpret the timezone. The Date object is always UTC.
      await pool.query(
        `INSERT INTO scheduled_rooms 
           (schedule_id, room_id, host_id, video_hash, video_title,
            video_thumbnail_path, video_file_path, stream_type,
            scheduled_at, status, shareable_link, link_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          scheduleId,
          roomId,
          host_id,
          video_hash,
          video_title,
          video_thumbnail_path || null,        // ✅ FIX 1: was missing entirely
          req.body.video_file_path || null,
          stream_type,
          scheduledDate,                       // ✅ FIX 2: parsed Date, not raw string
          'scheduled',
          shareableLink,
          linkExpiresAt,
        ]
      );

      await pool.query('COMMIT');

      const result = await pool.query(
        'SELECT * FROM scheduled_rooms WHERE schedule_id = $1',
        [scheduleId]
      );

      const room = result.rows[0];

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

// ── POST /api/rooms/:roomId/start ─────────────────────────────────────────
// Host triggers instant room activation from waiting room
// Bypasses the 30s auto-activation timer
router.post('/:roomId/start', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { host_id } = req.body;

    if (!isValidUUID(roomId) || !isValidUUID(host_id)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    // Security: verify requester is actually the host
    const check = await pool.query(
      'SELECT host_id, status FROM rooms WHERE room_id = $1',
      [roomId]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }

    if (check.rows[0].host_id !== host_id) {
      return res.status(403).json({ error: 'Only the host can start this room' });
    }

    if (check.rows[0].status === 'active') {
      return res.status(200).json({ message: 'Room already active' });
    }

    if (['completed', 'cancelled'].includes(check.rows[0].status)) {
      return res.status(400).json({ error: 'Room cannot be started' });
    }

    // Activate room instantly
    await pool.query('BEGIN');
    try {
      await pool.query(
        `UPDATE rooms SET status = 'active', scheduled_time = NOW()
         WHERE room_id = $1`,
        [roomId]
      );
      await pool.query(
        `UPDATE scheduled_rooms SET status = 'active'
         WHERE room_id = $1`,
        [roomId]
      );
      await pool.query('COMMIT');
      console.log(`🟢 HOST STARTED ROOM: ${roomId}`);
      res.json({ message: 'Room started successfully' });
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  } catch (error) {
    console.error('Start room error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/rooms/:roomId/cancel ──────────────────────────────────────
router.patch('/:roomId/cancel', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { host_id } = req.body;

    if (!isValidUUID(roomId) || !isValidUUID(host_id)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

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
router.post('/join', async (req, res) => {
  try {
    const { link } = req.body;

    if (!link || typeof link !== 'string') {
      return res.status(400).json({ error: 'Invalid link' });
    }

    const prefix = 'noirscreen://room/';
    if (!link.startsWith(prefix)) {
      return res.status(400).json({ error: 'Invalid link format' });
    }

    const roomId = link.substring(prefix.length);

    if (!isValidUUID(roomId)) {
      return res.status(400).json({ error: 'Invalid room ID in link' });
    }

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

// ── GET /api/rooms/completed/:userId ─────────────────────────────────────
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