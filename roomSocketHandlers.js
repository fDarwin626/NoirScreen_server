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
          `SELECT r.host_id, u.username, u.avatar_type, avatar_id, u.photo_url
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
        const { host_id, username, avatar_type, avatar_id, photo_url } = check.rows[0];
        const avatarUrl = avatar_type === 'custom' && photo_url
          ? photo_url
          : avatar_type === 'default' && avatar_id
          ? `default:${avatar_id}`
          : null;

        socket.join(roomId);

        // Only initialize state if room truly doesn't exist yet
        // Do NOT reset if host reconnects from waiting → watch transition
        if (!rooms.has(roomId)) {
          rooms.set(roomId, {
            ownerId: host_id,
            participants: new Map(),
            currentPosition: 0,
            isPlaying: false,
            ownerEndedRoom: false,
          });
        }

        // Add/update participant either way — preserves existing guests
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

// Refresh position from DB in case in-memory state is stale
        try {
          const posRow = await pool.query(
            'SELECT playback_position, is_playing FROM rooms WHERE room_id = $1', [roomId]
          );
          if (posRow.rows.length > 0) {
            state.currentPosition = posRow.rows[0].playback_position || state.currentPosition;
            state.isPlaying = posRow.rows[0].is_playing ?? state.isPlaying;
          }
        } catch (_) {}

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
        'UPDATE rooms SET playback_position=$1, current_time=$1, is_playing=true WHERE room_id=$2',
          [pos, roomId]);
    });

    socket.on('room_pause', async (data) => {
      if (!(await isRoomOwner(roomId, userId))) return;
      const pos = Math.max(0, parseInt(data?.position) || 0);
      const s = rooms.get(roomId);
      if (s) { s.currentPosition = pos; s.isPlaying = false; }
      io.to(roomId).emit('room_pause', { position: pos });
      await pool.query(
        'UPDATE rooms SET playback_position=$1, current_time=$1, is_playing=false WHERE room_id=$2',
          [pos, roomId]);
    });

    socket.on('room_seek', async (data) => {
      if (!(await isRoomOwner(roomId, userId))) return;
      const pos = Math.max(0, parseInt(data?.position) || 0);
      const s = rooms.get(roomId);
      if (s) s.currentPosition = pos;
      io.to(roomId).emit('room_seek', { position: pos });
      await pool.query(
        'UPDATE rooms SET playback_position=$1, current_time=$1 WHERE room_id=$2', [pos, roomId]);
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
      // Flag that the owner intentionally ended the room so _handleLeave
      // knows NOT to treat the subsequent disconnect as a transition
      const s = rooms.get(roomId);
      if (s) s.ownerEndedRoom = true;
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

    // ── WebRTC signaling — peer-to-peer voice ─────────────────────────────
    socket.on('webrtc_offer', (data) => {
      const { targetUserId, sdp } = data;
      if (!targetUserId || !sdp) return;
      const s = rooms.get(roomId);
      const target = s?.participants.get(targetUserId);
      if (!target) return;
      io.to(target.socketId).emit('webrtc_offer', { fromUserId: userId, sdp });
    });

    socket.on('webrtc_answer', (data) => {
      const { targetUserId, sdp } = data;
      if (!targetUserId || !sdp) return;
      const s = rooms.get(roomId);
      const target = s?.participants.get(targetUserId);
      if (!target) return;
      io.to(target.socketId).emit('webrtc_answer', { fromUserId: userId, sdp });
    });

    socket.on('webrtc_ice', (data) => {
      const { targetUserId, candidate } = data;
      if (!targetUserId || !candidate) return;
      const s = rooms.get(roomId);
      const target = s?.participants.get(targetUserId);
      if (!target) return;
      io.to(target.socketId).emit('webrtc_ice', { fromUserId: userId, candidate });
    });

    // ── Quick reactions ───
    socket.on('reaction', (data) => {
      const emoji = data?.emoji;
      if (!emoji || typeof emoji !== 'string') return;
      io.to(roomId).emit('reaction', { userId, emoji });
    });

    // join request socket events 
    // */This mirrowr all REST endpoint but let hosts who are offline-ish i guess? 
    // */ still recieve realtime popups when they reconnect to the room secket.

    // ^^^^^ Guest Cancels their own pending join request
      socket.on('cancle_join_request', async (data) => {
          const { requestId } = data;
          if (!requestId || !isValidUUID(requestId)) return;
          try {
            await pool.query(
              `DELETE FROM join_requests
              WHERE request_id = $1 AND requester_id = $2 AND status = 'pending'`
              , [requestId, userId]
            );
            // Tell the room the request is gone (cleans host's pending list)
                    socket.to(roomId).emit('join_request_cancelled', { requestId, requesterId: userId });
              } catch (e) { console.error('cancel_join_request:', e); }
            });

                // Host requests the current pending list on reconnect
            // (in case they missed the real-time popups while navigating)
            socket.on('fetch_pending_requests', async () => {
              const ownerCheck = await isRoomOwner(roomId, userId);
              if (!ownerCheck) return;
              try {
                const result = await pool.query(
                  `SELECT request_id, requester_id, username, avatar_url, created_at
                  FROM join_requests
                  WHERE room_id = $1 AND status = 'pending'
                  ORDER BY created_at ASC`,
                  [roomId]
                );
                socket.emit('pending_requests_list', { requests: result.rows });
              } catch (e) { console.error('fetch_pending_requests:', e); }
            });
          });

  async function _handleLeave(socket, userId, roomId, io) {
    socket.leave(roomId);
    const s = rooms.get(roomId);
    if (!s) return;
    s.participants.delete(userId);

    if (s.ownerId === userId) {
      // If ownerEndedRoom is true, the host pressed Stop — room already
      // ended via end_room handler, nothing left to do here
      if (s.ownerEndedRoom) return;

      try {
        const result = await pool.query(
          `SELECT status FROM rooms WHERE room_id = $1`, [roomId]
        );
        const status = result.rows[0]?.status;

        // Owner disconnected while room is active = waiting → watch transition
        // Do NOT end the room — guests stay connected, host will reconnect
        if (status === 'active') {
          console.log(`ℹ️  ROOM: Owner transitioning waiting→watch — keeping alive for guests`);
          return;
        }
      } catch (e) {
        console.error('_handleLeave status check error:', e);
      }

      // Room is not active and owner didn't press Stop — owner abandoned it
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