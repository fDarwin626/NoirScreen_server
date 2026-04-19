// routes/discoveryRoutes.js
// Mounted at /api/discovery in index.js
// All discovery + join-request endpoints with rate limiting

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

// ── UUID validation ───────────────────────────────────────────────────────────
function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ── Multer — thumbnail uploads ────────────────────────────────────────────────
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
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return cb(new Error('Only JPEG/PNG allowed'));
    }
    cb(null, true);
  },
});

// ── 1. GET /api/discovery/rooms?userId=xxx ────────────────────────────────────
// Returns ongoing (active) and scheduled (waiting) public rooms.
// BUG FIX: was using user_id — Flutter sends userId (camelCase)
router.get('/rooms', discoveryLimiter, async (req, res) => {
  try {
    // Accept both userId and user_id — Flutter sends userId
    const userId = req.query.userId || req.query.user_id;

    if (!userId || !isValidUUID(userId)) {
      return res.status(400).json({ error: 'Valid userId required' });
    }

    // BUG FIX: was referencing room_reports table which didn't exist
    // Now uses report_count column on rooms table (set by discoveryMigration)
    const REPORT_THRESHOLD = parseInt(process.env.REPORT_THRESHOLD || '1', 10);

    const ongoingResult = await pool.query(
      `SELECT
         r.room_id,
         r.title           AS video_title,
         r.stream_type,
         r.thumbnail_url,
         r.status,
         r.is_public,
         r.duration,
         r.scheduled_time,
         r.expires_at,
         u.username        AS host_username,
         u.photo_url       AS host_avatar,
         u.user_id         AS host_id,
         sr.shareable_link,
         sr.link_expires_at,
         (SELECT COUNT(*) FROM join_requests jr
            WHERE jr.room_id = r.room_id AND jr.status = 'accepted') AS participant_count
       FROM rooms r
       JOIN users u ON u.user_id = r.host_id
       LEFT JOIN scheduled_rooms sr ON sr.room_id = r.room_id
       WHERE r.is_public = true
         AND r.status = 'active'
         AND (r.expires_at IS NULL OR r.expires_at > NOW())
         AND (r.report_count IS NULL OR r.report_count < $2)
       ORDER BY r.scheduled_time DESC
       LIMIT 50`,
      [userId, REPORT_THRESHOLD]
    );

    const scheduledResult = await pool.query(
      `SELECT
         r.room_id,
         r.title           AS video_title,
         r.stream_type,
         r.thumbnail_url,
         r.status,
         r.is_public,
         r.duration,
         r.scheduled_time,
         r.expires_at,
         u.username        AS host_username,
         u.photo_url       AS host_avatar,
         u.user_id         AS host_id,
         sr.shareable_link,
         sr.link_expires_at,
         (SELECT COUNT(*) FROM join_requests jr
            WHERE jr.room_id = r.room_id AND jr.status = 'accepted') AS participant_count
       FROM rooms r
       JOIN users u ON u.user_id = r.host_id
       LEFT JOIN scheduled_rooms sr ON sr.room_id = r.room_id
       WHERE r.is_public = true
         AND r.status = 'waiting'
         AND (r.expires_at IS NULL OR r.expires_at > NOW())
         AND (r.report_count IS NULL OR r.report_count < $2)
       ORDER BY r.scheduled_time ASC
       LIMIT 50`,
      [userId, REPORT_THRESHOLD]
    );

    // For each room, check if this user has a pending/accepted/rejected request
    const allRoomIds = [
      ...ongoingResult.rows,
      ...scheduledResult.rows,
    ].map(r => r.room_id);

    let myRequestMap = {};
    if (allRoomIds.length > 0) {
      const reqResult = await pool.query(
        `SELECT room_id, request_id, status FROM join_requests
         WHERE requester_id = $1 AND room_id = ANY($2::uuid[])
         ORDER BY created_at DESC`,
        [userId, allRoomIds]
      );
      // Keep only the most recent request per room
      for (const row of reqResult.rows) {
        if (!myRequestMap[row.room_id]) {
          myRequestMap[row.room_id] = {
            requestId: row.request_id,
            status: row.status,
          };
        }
      }
    }

    const serialize = (row) => ({
      roomId: row.room_id,
      videoTitle: row.video_title || 'Untitled',
      streamType: row.stream_type || 'audio',
      status: row.status,
      // BUG FIX: was null when scheduled_rooms row missing — fallback to noirscreen:// link
      shareableLink: row.shareable_link || `noirscreen://room/${row.room_id}`,
      linkExpiresAt: row.link_expires_at
        ? new Date(row.link_expires_at).toISOString()
        : null,
      thumbnailUrl: row.thumbnail_url
        ? `${process.env.SERVER_BASE_URL || ''}${row.thumbnail_url}`
        : null,
      duration: parseInt(row.duration) || 0,
      scheduledAt: row.scheduled_time
        ? new Date(row.scheduled_time).toISOString()
        : null,
      hostId: row.host_id,
      hostUsername: row.host_username || 'Host',
      hostAvatar: row.host_avatar || null,
      acceptedCount: parseInt(row.participant_count) || 0,
      // Include this user's request status for this room (if any)
      myRequest: myRequestMap[row.room_id] || null,
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

// ── 2. POST /api/discovery/rooms/:roomId/thumbnail ────────────────────────────
// BUG FIX: was at /:roomId/thumbnail — Flutter calls /rooms/:roomId/thumbnail
router.post(
  '/rooms/:roomId/thumbnail',
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

      const check = await pool.query(
        'SELECT host_id FROM rooms WHERE room_id = $1',
        [roomId]
      );
      if (!check.rows.length || check.rows[0].host_id !== host_id) {
        return res.status(403).json({ error: 'Not authorised' });
      }

      let thumbnailUrl = null;

      if (req.file) {
        thumbnailUrl = `/uploads/thumbnails/${req.file.filename}`;
      } else if (thumbnail_base64) {
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

      await pool.query(
        'UPDATE rooms SET thumbnail_url = $1 WHERE room_id = $2',
        [thumbnailUrl, roomId]
      );

      res.json({
        thumbnail_url: `${process.env.SERVER_BASE_URL || ''}${thumbnailUrl}`,
      });
    } catch (e) {
      console.error('Thumbnail upload error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── 3. PATCH /api/discovery/rooms/:roomId/public ──────────────────────────────
// BUG FIX: was at /:roomId/visibility — Flutter calls /rooms/:roomId/public
router.patch('/rooms/:roomId/public', strictLimiter, async (req, res) => {
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

// ── 4. POST /api/discovery/rooms/:roomId/join-request ────────────────────────
// BUG FIX: was at /:roomId/request — Flutter calls /rooms/:roomId/join-request
router.post('/rooms/:roomId/join-request', joinRequestLimiter, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { requester_id, username, avatar_url } = req.body;

    if (!isValidUUID(roomId) || !isValidUUID(requester_id)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    const room = await pool.query(
      `SELECT r.room_id, r.host_id, r.status, r.expires_at, r.is_public,
              u.username AS host_username
       FROM rooms r
       JOIN users u ON u.user_id = r.host_id
       WHERE r.room_id = $1
         AND r.status NOT IN ('completed', 'cancelled')
         AND (r.expires_at IS NULL OR r.expires_at > NOW())`,
      [roomId]
    );

    if (!room.rows.length) {
      return res.status(404).json({ error: 'Room not found or expired' });
    }

    const { host_id, host_username } = room.rows[0];

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
        error: existing.rows[0].status === 'accepted'
          ? 'Already accepted'
          : 'Request already pending',
        status: existing.rows[0].status,
        requestId: existing.rows[0].request_id,
      });
    }

    const requestId = uuidv4();

    await pool.query(
      `INSERT INTO join_requests (request_id, room_id, requester_id, status, username, avatar_url, created_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, NOW())
       ON CONFLICT DO NOTHING`,
      [requestId, roomId, requester_id, username || null, avatar_url || null]
    );

    // Emit socket event so host gets real-time popup
    const io = req.app.get('io');
    if (io) {
      io.to(roomId).emit('join_request_received', {
        requestId,
        roomId,
        requesterId: requester_id,
        username: username || 'User',
        avatarUrl: avatar_url || null,
      });
    }

    res.status(201).json({ requestId, status: 'pending', host_username });
  } catch (e) {
    console.error('Join request error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 5. POST /api/discovery/rooms/:roomId/request/:requestId/accept ────────────
router.post('/rooms/:roomId/request/:requestId/accept', joinRequestLimiter, async (req, res) => {
  try {
    const { roomId, requestId } = req.params;
    const { host_id } = req.body;

    if (!isValidUUID(roomId) || !isValidUUID(requestId) || !isValidUUID(host_id)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    const room = await pool.query(
      'SELECT host_id FROM rooms WHERE room_id = $1', [roomId]
    );
    if (!room.rows.length || room.rows[0].host_id !== host_id) {
      return res.status(403).json({ error: 'Not authorised' });
    }

    const updated = await pool.query(
      `UPDATE join_requests SET status = 'accepted'
       WHERE request_id = $1 AND room_id = $2 AND status = 'pending'
       RETURNING requester_id`,
      [requestId, roomId]
    );

    if (!updated.rows.length) {
      return res.status(404).json({ error: 'Request not found or already resolved' });
    }

    // Get shareable link for the guest to navigate
    const linkResult = await pool.query(
      'SELECT shareable_link FROM scheduled_rooms WHERE room_id = $1', [roomId]
    );
    const shareableLink = linkResult.rows[0]?.shareable_link
      || `noirscreen://room/${roomId}`;

    // Emit socket so guest gets real-time notification
    const io = req.app.get('io');
    if (io) {
      io.to(roomId).emit('join_request_accepted', {
        requestId,
        requesterId: updated.rows[0].requester_id,
        roomId,
        shareableLink,
      });
    }

    res.json({ accepted: true, requester_id: updated.rows[0].requester_id, shareableLink });
  } catch (e) {
    console.error('Accept request error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 6. POST /api/discovery/rooms/:roomId/request/:requestId/reject ────────────
router.post('/rooms/:roomId/request/:requestId/reject', joinRequestLimiter, async (req, res) => {
  try {
    const { roomId, requestId } = req.params;
    const { host_id } = req.body;

    if (!isValidUUID(roomId) || !isValidUUID(requestId) || !isValidUUID(host_id)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    const room = await pool.query(
      'SELECT host_id FROM rooms WHERE room_id = $1', [roomId]
    );
    if (!room.rows.length || room.rows[0].host_id !== host_id) {
      return res.status(403).json({ error: 'Not authorised' });
    }

    const updated = await pool.query(
      `UPDATE join_requests SET status = 'rejected'
       WHERE request_id = $1 AND room_id = $2 AND status = 'pending'
       RETURNING requester_id`,
      [requestId, roomId]
    );

    if (!updated.rows.length) {
      return res.status(404).json({ error: 'Request not found or already resolved' });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(roomId).emit('join_request_rejected', {
        requestId,
        requesterId: updated.rows[0].requester_id,
        roomId,
      });
    }

    res.json({ rejected: true });
  } catch (e) {
    console.error('Reject request error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 7. GET /api/discovery/my-requests/:userId ─────────────────────────────────
// BUG FIX: Flutter calls /my-requests/:userId (path param) not ?user_id= (query)
router.get('/my-requests/:userId', discoveryLimiter, async (req, res) => {
  try {
    const { userId } = req.params;

    if (!isValidUUID(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
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
         r.stream_type,
         u.username    AS host_username,
         sr.shareable_link
       FROM join_requests jr
       JOIN rooms r ON r.room_id = jr.room_id
       JOIN users u ON u.user_id = r.host_id
       LEFT JOIN scheduled_rooms sr ON sr.room_id = r.room_id
       WHERE jr.requester_id = $1
         AND r.status NOT IN ('completed', 'cancelled')
         AND (r.expires_at IS NULL OR r.expires_at > NOW())
       ORDER BY jr.created_at DESC`,
      [userId]
    );

    const requests = result.rows.map((row) => ({
      requestId: row.request_id,
      roomId: row.room_id,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      videoTitle: row.video_title || 'Untitled',
      thumbnailUrl: row.thumbnail_url
        ? `${process.env.SERVER_BASE_URL || ''}${row.thumbnail_url}`
        : null,
      roomStatus: row.room_status,
      scheduledTime: row.scheduled_time
        ? new Date(row.scheduled_time).toISOString()
        : null,
      streamType: row.stream_type,
      hostUsername: row.host_username || 'Host',
      shareableLink: row.shareable_link || `noirscreen://room/${row.room_id}`,
    }));

    res.json({ requests });
  } catch (e) {
    console.error('My requests error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 8. POST /api/discovery/rooms/:roomId/report ───────────────────────────────
// BUG FIX: was at /:roomId/report and required a 'reason' field Flutter never sends
// Now reason is optional — defaults to 'inappropriate'
router.post('/rooms/:roomId/report', reportLimiter, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { reporter_id, reason } = req.body;

    if (!isValidUUID(roomId) || !isValidUUID(reporter_id)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    const room = await pool.query(
      'SELECT host_id FROM rooms WHERE room_id = $1',
      [roomId]
    );
    if (!room.rows.length) {
      return res.status(404).json({ error: 'Room not found' });
    }
    if (room.rows[0].host_id === reporter_id) {
      return res.status(400).json({ error: 'Cannot report your own room' });
    }

    // Increment report count — uses report_count column (added in discoveryMigration)
    const updated = await pool.query(
      `UPDATE rooms SET report_count = COALESCE(report_count, 0) + 1
       WHERE room_id = $1
       RETURNING report_count`,
      [roomId]
    );

    const newCount = parseInt(updated.rows[0]?.report_count || '0');
    const REPORT_THRESHOLD = parseInt(process.env.REPORT_THRESHOLD || '1', 10);

    if (newCount >= REPORT_THRESHOLD) {
      await pool.query(
        `UPDATE rooms SET is_public = false WHERE room_id = $1`,
        [roomId]
      );
      console.log(`🚨 ROOM HIDDEN FROM DISCOVERY: ${roomId} (${newCount} reports)`);
    }

    res.json({ reported: true });
  } catch (e) {
    console.error('Report error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;