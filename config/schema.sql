-- Users Table
CREATE TABLE IF NOT EXISTS users (
  user_id VARCHAR(255) PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  avatar_type VARCHAR(20) NOT NULL,
  avatar_id INTEGER,
  photo_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  total_rooms_created INTEGER DEFAULT 0,
  total_watch_time INTEGER DEFAULT 0
);

-- Rooms Table
CREATE TABLE IF NOT EXISTS rooms (
  room_id VARCHAR(255) PRIMARY KEY,
  host_id VARCHAR(255) NOT NULL,
  title TEXT,
  type VARCHAR(20) NOT NULL,
  comm_mode VARCHAR(20) NOT NULL,
  -- comm_mode: 'audio' (voice only) or 'video' (voice + camera)
  invitation_type VARCHAR(20) NOT NULL,
  -- invitation_type: 'link' or 'scheduled'
  stream_type VARCHAR(20) DEFAULT 'hls',
  -- stream_type: 'hls' (owner streams), 'sync' (all have file)
  scheduled_time TIMESTAMP,
  status VARCHAR(20) NOT NULL,
  -- status: waiting, active, paused, completed, cancelled
  video_hash VARCHAR(255),
  -- SHA256 hash of video file for Type 3 detection
  file_name TEXT,
  file_path TEXT,
  duration INTEGER,
  current_time REAL DEFAULT 0,
  is_playing BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  expires_at TIMESTAMP,
  FOREIGN KEY (host_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Room Participants Table
CREATE TABLE IF NOT EXISTS room_participants (
  id SERIAL PRIMARY KEY,
  room_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  left_at TIMESTAMP,
  FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Files Table
CREATE TABLE IF NOT EXISTS files (
  file_id VARCHAR(255) PRIMARY KEY,
  uploaded_by VARCHAR(255) NOT NULL,
  file_name TEXT NOT NULL,
  file_size BIGINT,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (uploaded_by) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Download Permissions Table
CREATE TABLE IF NOT EXISTS download_permissions (
  id SERIAL PRIMARY KEY,
  file_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  granted BOOLEAN DEFAULT FALSE,
  requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  granted_at TIMESTAMP,
  FOREIGN KEY (file_id) REFERENCES files(file_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active);
CREATE INDEX IF NOT EXISTS idx_rooms_host_id ON rooms(host_id);
CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status);
CREATE INDEX IF NOT EXISTS idx_room_participants_room_id ON room_participants(room_id);
CREATE INDEX IF NOT EXISTS idx_room_participants_user_id ON room_participants(user_id);

-- Stream chunks table
-- Tracks every HLS chunk uploaded during a stream
-- Chunks are deleted as playback moves forward (rolling 60s window)
-- All remaining chunks deleted when room ends
CREATE TABLE IF NOT EXISTS stream_chunks (
  chunk_id VARCHAR(255) PRIMARY KEY,
  room_id VARCHAR(255) NOT NULL,
  chunk_index INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP,
  FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);

-- Video stream cache table  
-- Stores .m3u8 playlist after stream ends so re-streaming
-- the same video skips the chunking step entirely
CREATE TABLE IF NOT EXISTS video_stream_cache (
  video_hash VARCHAR(255) PRIMARY KEY,
  playlist_path TEXT NOT NULL,
  duration INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  last_used TIMESTAMP DEFAULT NOW()
);

-- Scheduled rooms table
-- Stores scheduled watch parties with countdown data
-- Links back to rooms table
CREATE TABLE IF NOT EXISTS scheduled_rooms (
  schedule_id VARCHAR(255) PRIMARY KEY,
  room_id VARCHAR(255) NOT NULL,
  host_id VARCHAR(255) NOT NULL,
  video_hash VARCHAR(255) NOT NULL,
  video_title TEXT NOT NULL,
  video_file_path TEXT,
  video_thumbnail_path TEXT,
  stream_type VARCHAR(20) NOT NULL,
  -- stream_type: 'hls' (Type1), 'p2p_download' (Type2), 'sync' (Type3)
  scheduled_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  status VARCHAR(20) DEFAULT 'scheduled',
  -- status: scheduled, active, completed, cancelled
  shareable_link TEXT NOT NULL,
  link_expires_at TIMESTAMP NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE,
  FOREIGN KEY (host_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Room invitees table
-- Tracks who has been invited and whether they joined
CREATE TABLE IF NOT EXISTS room_invitees (
  id SERIAL PRIMARY KEY,
  room_id VARCHAR(255) NOT NULL,
  joined_via_link BOOLEAN DEFAULT FALSE,
  joined_at TIMESTAMP,
  device_id TEXT,
  FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_stream_chunks_room_id ON stream_chunks(room_id);
CREATE INDEX IF NOT EXISTS idx_stream_chunks_created_at ON stream_chunks(created_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_rooms_host_id ON scheduled_rooms(host_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_rooms_status ON scheduled_rooms(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_rooms_scheduled_at ON scheduled_rooms(scheduled_at);