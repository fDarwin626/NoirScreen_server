const express = require('express');
const router = express.Router();
const axios = require('axios');

// Fetch movie poster from OMDb API
router.get('/poster', async (req, res) => {
  try {
    const { title } = req.query;

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    // Sanitize input
    const sanitizedTitle = title.trim().substring(0, 100);

    // Call OMDb API with server-side key
    const response = await axios.get('http://www.omdbapi.com/', {
      params: {
        apikey: process.env.OMDB_API_KEY,
        t: sanitizedTitle,
      },
      timeout: 5000,
    });

    if (response.data.Response === 'True' && response.data.Poster !== 'N/A') {
      return res.json({
        success: true,
        posterUrl: response.data.Poster,
        title: response.data.Title,
        year: response.data.Year,
      });
    }

    return res.json({ success: false, message: 'Poster not found' });
  } catch (error) {
    console.error('Poster error:', error.message);
    res.status(500).json({ error: 'Failed to fetch poster' });
  }
});

module.exports = router;