// routes/discoveryRoutes.js
// All endpoints powering the Discovery screen and join-request flow.
// Every route is rate-limited. Every ID is validated before hitting DB.

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
  discoveryLimiter,
  joinRequestLimiter,
  reportLimiter,
  strictLimiter,
} = require('../middleware/rateLimiter');

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// Multer — thumbnail uploads stored in /uploads/thumbnails/
// Max 2 MB, JPEG/PNG only. Filename = roomId.jpg for easy lookup.
const thumbnailStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'thumbnails');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = file.mimetype === 'image/png' ? '.png' : '.jpg';
    cb(null, `${req.params.roomId}${ext}`);
  },
});

const thumbnailUpload = multer({
  storage: thumbnailStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png'].includes(file.mimetype)) {
      return cb(new Error('Only JPEG/PNG allowed'));
    }
    cb(null, true);
  },
});

// ── 1. Upload thumbnail when host makes room public ───────────────────────────
// POST /api/discovery/:roomId/thumbnail
// Body: multipart/form-data — field "thumbnail" (image file)
// Also accepts base64 in JSON body as "thumbnail_base64"
router.post(
  '/:roomId/thumbnail',
  strictLimiter,
  (req, res, next) => {
    if (!isValidUUID(req.params.roomId)) {
      return res.status(400).json({ error: 'Invalid room ID' });
    }
    next();
  },
  thumbnailUpload.single('thumbnail'),
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const { host_id, thumbnail_base64 } = req.body;

      if (!isValidUUID(host_id)) {
        return res.status(400).json({ error: 'Invalid host ID' });
      }

      // Verify ownership
      const check = await pool.query(
        'SELECT host_id FROM rooms WHERE room_id = $1',
        [roomId]
      );
      if (!check.rows.length || check.rows[0].host_id !== host_id) {
        return res.status(403).json({ error: 'Not authorised' });
      }

      let thumbnailUrl = null;

      if (req.file) {
        // Multipart upload
        thumbnailUrl = `/uploads/thumbnails/${req.file.filename}`;
      } else if (thumbnail_base64) {
        // Base64 fallback — Flutter sends this when multipart is awkward
        const base64Data = thumbnail_base64.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        if (buffer.length > 2 * 1024 * 1024) {
          return res.status(400).json({ error: 'Image too large (max 2 MB)' });
        }
        const dir = path.join(__dirname, '..', 'uploads', 'thumbnails');
        fs.mkdirSync(dir, { recursive: true });
        const filename = `${roomId}.jpg`;
        fs.writeFileSync(path.join(dir, filename), buffer);
        thumbnailUrl = `/uploads/thumbnails/${filename}`;
      } else {
        return res.status(400).json({ error: 'No thumbnail provided' });
      }

      // Save URL to rooms table
      await pool.query(
        'UPDATE rooms SET thumbnail_url = $1 WHERE room_id = $2',
        [thumbnailUrl, roomId]
      );
      await pool.query(
        'UPDATE scheduled_rooms SET thumbnail_url = $1 WHERE room_id = $2',
        [thumbnailUrl, roomId]
      );

      res.json({ thumbnail_url: thumbnailUrl });
    } catch (e) {
      console.error('Thumbnail upload error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── 2. Toggle public/private ──────────────────────────────────────────────────
// PATCH /api/discovery/:roomId/visibility
// Body: { host_id, is_public }
router.patch('/:roomId/visibility', strictLimiter, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { host_id, is_public } = req.body;

    if (!isValidUUID(roomId) || !isValidUUID(host_id)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    const check = await pool.query(
      'SELECT host_id FROM rooms WHERE room_id = $1',
      [roomId]
    );
    if (!check.rows.length || check.rows[0].host_id !== host_id) {
      return res.status(403).json({ error: 'Not authorised' });
    }

    await pool.query(
      'UPDATE rooms SET is_public = $1 WHERE room_id = $2',
      [Boolean(is_public), roomId]
    );

    res.json({ is_public: Boolean(is_public) });
  } catch (e) {
    console.error('Visibility toggle error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 3. Get public rooms (discovery listing) ───────────────────────────────────
// GET /api/discovery/rooms?user_id=xxx
// Returns two arrays: ongoing (active) and scheduled
// Excludes rooms reported by the requesting user
// Excludes blocked rooms (report count >= threshold)
router.get('/rooms', discoveryLimiter, async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id || !isValidUUID(user_id)) {
      return res.status(400).json({ error: 'Valid user_id required' });
    }

    // Report threshold: 1 for testing, bump to 4 for production
    const REPORT_THRESHOLD = 1;

    const ongoingResult = await pool.query(
      `SELECT
         r.room_id,
         r.title          AS video_title,
         r.stream_type,
         r.thumbnail_url,
         r.status,
         r.is_public,
         u.username       AS host_username,
         u.photo_url      AS host_avatar,
         u.user_id        AS host_id,
         r.scheduled_time,
         r.expires_at,
         (SELECT COUNT(*) FROM join_requests jr
            WHERE jr.room_id = r.room_id AND jr.status = 'accepted') AS participant_count,
         (SELECT COUNT(*) FROM room_reports rr
            WHERE rr.room_id = r.room_id) AS report_count
       FROM rooms r
       JOIN users u ON u.user_id = r.host_id
       WHERE r.is_public = true
         AND r.status = 'active'
         AND r.expires_at > NOW()
         AND r.status NOT IN ('completed', 'cancelled')
         AND r.room_id NOT IN (
           SELECT room_id FROM room_reports WHERE reporter_id = $1
         )
       GROUP BY r.room_id, u.username, u.photo_url, u.user_id
       HAVING (SELECT COUNT(*) FROM room_reports rr WHERE rr.room_id = r.room_id) < $2
       ORDER BY r.scheduled_time DESC
       LIMIT 50`,
      [user_id, REPORT_THRESHOLD]
    );

    const scheduledResult = await pool.query(
      `SELECT
         r.room_id,
         r.title          AS video_title,
         r.stream_type,
         r.thumbnail_url,
         r.status,
         r.is_public,
         u.username       AS host_username,
         u.photo_url      AS host_avatar,
         u.user_id        AS host_id,
         r.scheduled_time,
         r.expires_at,
         (SELECT COUNT(*) FROM join_requests jr
            WHERE jr.room_id = r.room_id AND jr.status = 'accepted') AS participant_count
       FROM rooms r
       JOIN users u ON u.user_id = r.host_id
       WHERE r.is_public = true
         AND r.status = 'waiting'
         AND r.scheduled_time > NOW()
         AND r.expires_at > NOW()
         AND r.room_id NOT IN (
           SELECT room_id FROM room_reports WHERE reporter_id = $1
         )
       ORDER BY r.scheduled_time ASC
       LIMIT 50`,
      [user_id]
    );

    const serialize = (row) => ({
      ...row,
      scheduled_time: row.scheduled_time
        ? new Date(row.scheduled_time).toISOString()
        : null,
      expires_at: row.expires_at
        ? new Date(row.expires_at).toISOString()
        : null,
      participant_count: parseInt(row.participant_count) || 0,
    });

    res.json({
      ongoing: ongoingResult.rows.map(serialize),
      scheduled: scheduledResult.rows.map(serialize),
    });
  } catch (e) {
    console.error('Discovery listing error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 4. Send join request ──────────────────────────────────────────────────────
// POST /api/discovery/:roomId/request
// Body: { requester_id }
router.post('/:roomId/request', joinRequestLimiter, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { requester_id } = req.body;

    if (!isValidUUID(roomId) || !isValidUUID(requester_id)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    // Room must exist and be valid
    const room = await pool.query(
      `SELECT r.room_id, r.host_id, r.status, r.expires_at, r.is_public,
              u.username AS host_username
       FROM rooms r
       JOIN users u ON u.user_id = r.host_id
       WHERE r.room_id = $1
         AND r.status NOT IN ('completed', 'cancelled')
         AND r.expires_at > NOW()`,
      [roomId]
    );

    if (!room.rows.length) {
      return res.status(404).json({ error: 'Room not found or expired' });
    }

    const { host_id, host_username } = room.rows[0];

    // Can't request to join your own room
    if (host_id === requester_id) {
      return res.status(400).json({ error: 'You are the host of this room' });
    }

    // Check for existing pending/accepted request
    const existing = await pool.query(
      `SELECT request_id, status FROM join_requests
       WHERE room_id = $1 AND requester_id = $2
         AND status IN ('pending', 'accepted')`,
      [roomId, requester_id]
    );

    if (existing.rows.length) {
      return res.status(409).json({
        error:
          existing.rows[0].status === 'accepted'
            ? 'Already accepted into this room'
            : 'Request already pending',
        status: existing.rows[0].status,
        request_id: existing.rows[0].request_id,
      });
    }

    // Get requester info for the notification payload
    const requester = await pool.query(
      'SELECT username, photo_url FROM users WHERE user_id = $1',
      [requester_id]
    );

    if (!requester.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const requestId = uuidv4();

    await pool.query(
      `INSERT INTO join_requests (request_id, room_id, requester_id, status, created_at)
       VALUES ($1, $2, $3, 'pending', NOW())`,
      [requestId, roomId, requester_id]
    );

    res.status(201).json({
      request_id: requestId,
      status: 'pending',
      host_username,
    });
  } catch (e) {
    console.error('Join request error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 5. Accept join request ────────────────────────────────────────────────────
// POST /api/discovery/:roomId/request/:requestId/accept
// Body: { host_id }
router.post('/:roomId/request/:requestId/accept', joinRequestLimiter, async (req, res) => {
  try {
    const { roomId, requestId } = req.params;
    const { host_id } = req.body;

    if (!isValidUUID(roomId) || !isValidUUID(requestId) || !isValidUUID(host_id)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    // Verify host
    const room = await pool.query(
      'SELECT host_id FROM rooms WHERE room_id = $1',
      [roomId]
    );
    if (!room.rows.length || room.rows[0].host_id !== host_id) {
      return res.status(403).json({ error: 'Not authorised' });
    }

    const updated = await pool.query(
      `UPDATE join_requests
       SET status = 'accepted'
       WHERE request_id = $1 AND room_id = $2 AND status = 'pending'
       RETURNING requester_id`,
      [requestId, roomId]
    );

    if (!updated.rows.length) {
      return res.status(404).json({ error: 'Request not found or already resolved' });
    }

    res.json({ accepted: true, requester_id: updated.rows[0].requester_id });
  } catch (e) {
    console.error('Accept request error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 6. Reject join request ────────────────────────────────────────────────────
// POST /api/discovery/:roomId/request/:requestId/reject
// Body: { host_id }
router.post('/:roomId/request/:requestId/reject', joinRequestLimiter, async (req, res) => {
  try {
    const { roomId, requestId } = req.params;
    const { host_id } = req.body;

    if (!isValidUUID(roomId) || !isValidUUID(requestId) || !isValidUUID(host_id)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    const room = await pool.query(
      'SELECT host_id FROM rooms WHERE room_id = $1',
      [roomId]
    );
    if (!room.rows.length || room.rows[0].host_id !== host_id) {
      return res.status(403).json({ error: 'Not authorised' });
    }

    const updated = await pool.query(
      `UPDATE join_requests
       SET status = 'rejected'
       WHERE request_id = $1 AND room_id = $2 AND status = 'pending'
       RETURNING requester_id`,
      [requestId, roomId]
    );

    if (!updated.rows.length) {
      return res.status(404).json({ error: 'Request not found or already resolved' });
    }

    res.json({ rejected: true, requester_id: updated.rows[0].requester_id });
  } catch (e) {
    console.error('Reject request error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 7. Get guest's own pending requests ───────────────────────────────────────
// GET /api/discovery/my-requests?user_id=xxx
// Returns all join requests this user has sent, with current status
router.get('/my-requests', discoveryLimiter, async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id || !isValidUUID(user_id)) {
      return res.status(400).json({ error: 'Valid user_id required' });
    }

    const result = await pool.query(
      `SELECT
         jr.request_id,
         jr.room_id,
         jr.status,
         jr.created_at,
         r.title       AS video_title,
         r.thumbnail_url,
         r.status      AS room_status,
         r.scheduled_time,
         r.expires_at,
         r.stream_type,
         r.is_public,
         u.username    AS host_username,
         u.photo_url   AS host_avatar,
         u.user_id     AS host_id
       FROM join_requests jr
       JOIN rooms r ON r.room_id = jr.room_id
       JOIN users u ON u.user_id = r.host_id
       WHERE jr.requester_id = $1
         AND r.status NOT IN ('completed', 'cancelled')
         AND r.expires_at > NOW()
       ORDER BY jr.created_at DESC`,
      [user_id]
    );

    const requests = result.rows.map((row) => ({
      ...row,
      created_at: new Date(row.created_at).toISOString(),
      scheduled_time: row.scheduled_time
        ? new Date(row.scheduled_time).toISOString()
        : null,
      expires_at: row.expires_at
        ? new Date(row.expires_at).toISOString()
        : null,
    }));

    res.json({ requests });
  } catch (e) {
    console.error('My requests error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 8. Report a room ──────────────────────────────────────────────────────────
// POST /api/discovery/:roomId/report
// Body: { reporter_id, reason }
// 1 report = takedown for testing (bump to 4 for production in threshold)
router.post('/:roomId/report', reportLimiter, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { reporter_id, reason } = req.body;

    if (!isValidUUID(roomId) || !isValidUUID(reporter_id)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    const allowedReasons = ['spam', 'inappropriate', 'fake', 'other'];
    if (!reason || !allowedReasons.includes(reason)) {
      return res.status(400).json({ error: 'Invalid reason' });
    }

    // Can't report your own room
    const room = await pool.query(
      'SELECT host_id FROM rooms WHERE room_id = $1 AND expires_at > NOW()',
      [roomId]
    );
    if (!room.rows.length) {
      return res.status(404).json({ error: 'Room not found' });
    }
    if (room.rows[0].host_id === reporter_id) {
      return res.status(400).json({ error: 'Cannot report your own room' });
    }

    // Prevent duplicate reports from same user
    const duplicate = await pool.query(
      'SELECT report_id FROM room_reports WHERE room_id = $1 AND reporter_id = $2',
      [roomId, reporter_id]
    );
    if (duplicate.rows.length) {
      return res.status(409).json({ error: 'Already reported' });
    }

    await pool.query(
      `INSERT INTO room_reports (report_id, room_id, reporter_id, reason, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [uuidv4(), roomId, reporter_id, reason]
    );

    // Check threshold — 1 for testing
    const REPORT_THRESHOLD = 1;
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM room_reports WHERE room_id = $1',
      [roomId]
    );
    const reportCount = parseInt(countResult.rows[0].count);

    if (reportCount >= REPORT_THRESHOLD) {
      // Take down — mark room private and hide from discovery
      await pool.query(
        `UPDATE rooms SET is_public = false, status = 'cancelled'
         WHERE room_id = $1`,
        [roomId]
      );
      await pool.query(
        `UPDATE scheduled_rooms SET status = 'cancelled' WHERE room_id = $1`,
        [roomId]
      );
      console.log(`🚨 ROOM TAKEN DOWN: ${roomId} (${reportCount} reports)`);
    }

    res.json({ reported: true });
  } catch (e) {
    console.error('Report error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;