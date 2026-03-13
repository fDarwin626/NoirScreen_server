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
  invitation_type VARCHAR(20) NOT NULL,
  scheduled_time TIMESTAMP,
  status VARCHAR(20) NOT NULL,
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