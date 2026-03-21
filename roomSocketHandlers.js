const pool = require('./config/database');

// In-memory room state — tracks position and participants
// Resets on server restart — acceptable for launch
const rooms = new Map();

function setupRoomHandlers(io) {

  // Verify owner against DB — never trust client claim
  async function isRoomOwner(roomId, userId) {
    try {
      const r = await pool.query(
        'SELECT host_id FROM rooms WHERE room_id = $1', [roomId]);
      return r.rows.length > 0 && r.rows[0].host_id === userId;
    } catch { return false; }
  }

  function isValidUUID(str) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  }

  io.on('connection', (socket) => {
    const { userId, roomId } = socket.handshake.query;

    // Disconnect immediately if params are invalid
    if (!userId || !roomId || !isValidUUID(userId) || !isValidUUID(roomId)) {
      socket.disconnect(true);
      return;
    }

    socket.on('join_room', async () => {
      try {
        const check = await pool.query(
          `SELECT r.host_id, u.username, u.avatar_type, u.photo_url
           FROM rooms r
           JOIN users u ON u.user_id = $1
           WHERE r.room_id = $2
             AND r.status NOT IN ('cancelled','completed')
             AND r.expires_at > NOW()`,
          [userId, roomId]
        );
        if (check.rows.length === 0) {
          socket.emit('error', { message: 'Room not found or expired' });
          return;
        }
        const { host_id, username , avatar_type, photo_url } = check.rows[0];
        const avatarUrl = (avatar_type === 'custom' && photo_url) ? photo_url : null;

        socket.join(roomId);

        if (!rooms.has(roomId)) {
          rooms.set(roomId, {
            ownerId: host_id,
            participants: new Map(),
            currentPosition: 0,
            isPlaying: false,
          });
        }
        const state = rooms.get(roomId);
        state.participants.set(userId, { socketId: socket.id, username, avatarUrl });

        // Tell others this person joined
        socket.to(roomId).emit('participant_joined',
          { userId, username, avatarPath: avatarUrl });
          // Send existing participants to the new joiner
        state.participants.forEach((participant, participantUserId) => {
          if (participantUserId !== userId) {
            socket.emit('participant_joined', {
              userId: participantUserId,
              username: participant.username,
              avatarPath: participant.avatarUrl || null,
            });
          }
        });

        // Send current playback state so new joiner syncs immediately
        socket.emit('sync_state', {
          position: state.currentPosition,
          isPlaying: state.isPlaying,
        });

      } catch (e) { console.error('join_room:', e); }
    });

    socket.on('leave_room', () => _handleLeave(socket, userId, roomId, io));
    socket.on('disconnect', () => _handleLeave(socket, userId, roomId, io));

    socket.on('room_play', async (data) => {
      if (!(await isRoomOwner(roomId, userId))) return;
      const pos = Math.max(0, parseInt(data?.position) || 0);
      const s = rooms.get(roomId);
      if (s) { s.currentPosition = pos; s.isPlaying = true; }
      io.to(roomId).emit('room_play', { position: pos });
      await pool.query(
        'UPDATE rooms SET playback_position=$1, is_playing=true WHERE room_id=$2',
        [pos, roomId]);
    });

    socket.on('room_pause', async (data) => {
      if (!(await isRoomOwner(roomId, userId))) return;
      const pos = Math.max(0, parseInt(data?.position) || 0);
      const s = rooms.get(roomId);
      if (s) { s.currentPosition = pos; s.isPlaying = false; }
      io.to(roomId).emit('room_pause', { position: pos });
      await pool.query(
        'UPDATE rooms SET playback_position=$1, is_playing=false WHERE room_id=$2',
        [pos, roomId]);
    });

    socket.on('room_seek', async (data) => {
      if (!(await isRoomOwner(roomId, userId))) return;
      const pos = Math.max(0, parseInt(data?.position) || 0);
      const s = rooms.get(roomId);
      if (s) s.currentPosition = pos;
      io.to(roomId).emit('room_seek', { position: pos });
      await pool.query(
        'UPDATE rooms SET playback_position=$1 WHERE room_id=$2', [pos, roomId]);
    });

    socket.on('mute_user', async (data) => {
      if (!(await isRoomOwner(roomId, userId))) return;
      const tid = data?.targetUserId;
      if (!tid || !isValidUUID(tid)) return;
      const s = rooms.get(roomId);
      const target = s?.participants.get(tid);
      if (target) io.to(target.socketId).emit('user_muted', { userId: tid });
      socket.to(roomId).emit('user_muted', { userId: tid });
    });

    socket.on('kick_user', async (data) => {
      if (!(await isRoomOwner(roomId, userId))) return;
      const tid = data?.targetUserId;
      if (!tid || !isValidUUID(tid) || tid === userId) return;
      const s = rooms.get(roomId);
      const target = s?.participants.get(tid);
      if (target) {
        io.to(target.socketId).emit('user_kicked', { userId: tid });
        socket.to(roomId).emit('participant_left', { userId: tid });
        s.participants.delete(tid);
        const ts = io.sockets.sockets.get(target.socketId);
        if (ts) ts.leave(roomId);
      }
    });

    socket.on('end_room', async () => {
      if (!(await isRoomOwner(roomId, userId))) return;
      io.to(roomId).emit('room_ended', {});
      await pool.query(
        `UPDATE rooms SET status='completed' WHERE room_id=$1`, [roomId]);
      await pool.query(
        `UPDATE scheduled_rooms SET status='completed' WHERE room_id=$1`, [roomId]);
      rooms.delete(roomId);
    });

    socket.on('speaking', (data) => {
      const speaking = data?.speaking === true;
      socket.to(roomId).emit('speaking', { userId, speaking });
    });
  });

  async function _handleLeave(socket, userId, roomId, io) {
    socket.leave(roomId);
    const s = rooms.get(roomId);
    if (!s) return;
    s.participants.delete(userId);
    if (s.ownerId === userId) {
      io.to(roomId).emit('room_ended', {});
      rooms.delete(roomId);
      await pool.query(
        `UPDATE rooms SET status='completed' WHERE room_id=$1`, [roomId]);
      await pool.query(
        `UPDATE scheduled_rooms SET status='completed' WHERE room_id=$1`, [roomId]);
    } else {
      io.to(roomId).emit('participant_left', { userId });
    }
  }
}

module.exports = { setupRoomHandlers };