const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// File upload configuration
const storage = multer.memoryStorage(); // Store in memory for validation
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max
  },
});

// Whitelist of allowed image MIME types (security)
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
];

// Validate image file
function validateImageFile(file) {
  if (!file) {
    return { valid: false, error: 'No file provided' };
  }

  // Check MIME type
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    return {
      valid: false,
      error: `Invalid file type. Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}`,
    };
  }

  // Check file size
  if (file.size > 5 * 1024 * 1024) {
    return { valid: false, error: 'File size must be less than 5MB' };
  }

  // Check magic bytes (first bytes of file - prevents fake extensions)
  const magicBytes = file.buffer.slice(0, 4).toString('hex');

  const validMagicBytes = {
    'ffd8ffe0': 'image/jpeg', // JPEG
    'ffd8ffe1': 'image/jpeg', // JPEG
    'ffd8ffe2': 'image/jpeg', // JPEG
    '89504e47': 'image/png',  // PNG
    '47494638': 'image/gif',  // GIF
    '52494646': 'image/webp', // WEBP (starts with RIFF)
  };

  const detectedType = Object.keys(validMagicBytes).find((magic) =>
    magicBytes.startsWith(magic)
  );

  if (!detectedType) {
    return {
      valid: false,
      error: 'File appears to be corrupted or not a valid image',
    };
  }

  return { valid: true };
}

// POST /api/users/register - Create anonymous user
router.post('/register', upload.single('avatar_photo'), async (req, res) => {
  try {
    const { username, avatar_type, avatar_id } = req.body;
    const avatarPhoto = req.file;

    // Validation
    if (!username || !avatar_type) {
      return res.status(400).json({
        error: 'Missing required fields: username, avatar_type',
      });
    }

    // Username validation
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({
        error: 'Username must be between 3 and 20 characters',
      });
    }

    // Sanitize username (only alphanumeric, underscore, dash)
    const sanitizedUsername = username.replace(/[^a-zA-Z0-9_-]/g, '');
    if (sanitizedUsername !== username) {
      return res.status(400).json({
        error: 'Username can only contain letters, numbers, underscore, and dash',
      });
    }

    // Check username uniqueness
    const usernameCheck = await pool.query(
      'SELECT user_id FROM users WHERE username = $1',
      [sanitizedUsername]
    );

    if (usernameCheck.rows.length > 0) {
      return res.status(409).json({
        error: 'Username already taken',
      });
    }

    // Avatar validation
    let photoUrl = null;

    if (avatar_type === 'custom') {
      // Validate custom photo
      if (!avatarPhoto) {
        return res.status(400).json({
          error: 'Custom avatar selected but no photo provided',
        });
      }

      // Security: Validate image file
      const validation = validateImageFile(avatarPhoto);
      if (!validation.valid) {
        return res.status(400).json({
          error: validation.error,
        });
      }

      // Save file to uploads folder
      // On Render filesystem is ephemeral — store image as base64 in DB
      // When we add cloud storage (S3/Cloudinary) this gets replaced
      const base64Image = `data:${avatarPhoto.mimetype};base64,${avatarPhoto.buffer.toString('base64')}`;
      photoUrl = base64Image;
    } else if (avatar_type === 'default') {
      // Validate avatar_id
      if (!avatar_id || avatar_id < 1 || avatar_id > 20) {
        return res.status(400).json({
          error: 'Invalid avatar_id. Must be between 1 and 20',
        });
      }
    } else {
      return res.status(400).json({
        error: 'avatar_type must be "default" or "custom"',
      });
    }

    // Generate anonymous user ID
    const userId = uuidv4();

    // Insert user into database
    const query = `
      INSERT INTO users (user_id, username, avatar_type, avatar_id, photo_url, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      RETURNING *
    `;

    const result = await pool.query(query, [
      userId,
      sanitizedUsername,
      avatar_type,
      avatar_id || null,
      photoUrl,
    ]);

    res.status(201).json({
      message: 'User created successfully',
      user: result.rows[0],
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

// GET /api/users/:userId - Get user by ID
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const query = 'SELECT * FROM users WHERE user_id = $1';
    const result = await pool.query(query, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    res.json({
      user: result.rows[0],
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

module.exports = router;