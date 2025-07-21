const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
const whitelist = ['https://citf-back.coolify.teczos.cloud/', 'http://localhost', 'null', 'http://127.0.0.1:5500'];
const corsOptions = {
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // The 'null' origin is sent by browsers for local files.
    if (origin === 'null' || whitelist.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/uploads', express.static('uploads'));

// PostgreSQL Connection
const db = new Pool({
  host: '38.242.214.96',
  user: 'postgres',
  password: 'JJaJC6ttdfBRdPqd5K9M8ZrQmcDzPbkYGx7OK84qW5PMedAZwO7OdRxMsP9hoaMa',
  database: 'postgres',
  port: 2345,
});

// Helper: Query wrapper for PostgreSQL
async function pgQuery(sql, params = []) {
  const result = await db.query(sql, params);
  return result.rows;
}

// Multer Setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// Helper: Delete files by image URLs array
function deleteFiles(imageUrls) {
  imageUrls.forEach((imgUrl) => {
    const filepath = path.join(__dirname, imgUrl);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  });
}

// === Projects ===

// GET all projects with their images
app.get('/api/projects', async (req, res) => {
  const sql = `
    SELECT p.id, p.title, p.description, pi.image_url
    FROM projects p
    LEFT JOIN project_images pi ON p.id = pi.project_id
    ORDER BY p.id DESC
  `;
  try {
    const results = await pgQuery(sql);
    // Group images by project
    const projectsMap = new Map();
    results.forEach(({ id, title, description, image_url }) => {
      if (!projectsMap.has(id)) {
        projectsMap.set(id, { id, title, description, images: [] });
      }
      if (image_url) {
        // Send relative path to the frontend
        projectsMap.get(id).images.push(image_url);
      }
    });
    const projects = Array.from(projectsMap.values());
    res.json(projects);
  } catch (err) {
    console.error('Error fetching projects:', err);
    res.status(500).json({ message: 'Failed to fetch projects', error: err });
  }
});

// GET single project by id (with images)
app.get('/api/projects/:id', async (req, res) => {
  const projectId = req.params.id;
  const sql = `
    SELECT p.id, p.title, p.description, pi.image_url
    FROM projects p
    LEFT JOIN project_images pi ON p.id = pi.project_id
    WHERE p.id = $1
  `;
  try {
    const results = await pgQuery(sql, [projectId]);
    if (results.length === 0) {
      return res.status(404).json({ message: 'Project not found' });
    }
    const project = {
      id: results[0].id,
      title: results[0].title,
      description: results[0].description,
      images: [],
    };
    results.forEach(({ image_url }) => {
      if (image_url) project.images.push(image_url);
    });
    res.json(project);
  } catch (err) {
    console.error('Error fetching project:', err);
    res.status(500).json({ message: 'Failed to fetch project', error: err });
  }
});

// POST add project with images (up to 5)
app.post('/api/projects', upload.array('images', 5), async (req, res) => {
  const { title, description } = req.body;
  const images = req.files;
  if (!title || !description) {
    return res.status(400).json({ message: 'Title and Description are required' });
  }
  try {
    const sqlProject = 'INSERT INTO projects (title, description) VALUES ($1, $2) RETURNING id';
    const result = await pgQuery(sqlProject, [title, description]);
    const projectId = result[0].id;
    if (!images || images.length === 0) {
      return res.status(201).json({ message: 'Project saved without images', projectId });
    }
    const sqlImages = 'INSERT INTO project_images (project_id, image_url) VALUES ($1, $2)';
    for (const img of images) {
      await pgQuery(sqlImages, [projectId, `/uploads/${img.filename}`]);
    }
    res.status(201).json({ message: 'Project and images saved successfully', projectId });
  } catch (err) {
    console.error('Error inserting project:', err);
    res.status(500).json({ message: 'Error inserting project', error: err });
  }
});

// PUT update project and optionally images by id
app.put('/api/projects/:id', upload.array('images', 5), async (req, res) => {
  const projectId = req.params.id;
  const { title, description } = req.body;
  const images = req.files;
  if (!title || !description) {
    return res.status(400).json({ message: 'Title and Description are required' });
  }
  try {
    const sqlUpdate = 'UPDATE projects SET title = $1, description = $2 WHERE id = $3';
    await pgQuery(sqlUpdate, [title, description, projectId]);
    if (!images || images.length === 0) {
      return res.status(200).json({ message: 'Project updated successfully (images unchanged)' });
    }
    // Delete old images from disk and DB
    {
      const sqlSelectImages = 'SELECT image_url FROM project_images WHERE project_id = $1';
      const oldImages = await pgQuery(sqlSelectImages, [projectId]);
      const oldImageUrls = oldImages.map((row) => row.image_url);
      deleteFiles(oldImageUrls);
      const sqlDeleteImages = 'DELETE FROM project_images WHERE project_id = $1';
      await pgQuery(sqlDeleteImages, [projectId]);
    }
    const sqlInsertImages = 'INSERT INTO project_images (project_id, image_url) VALUES ($1, $2)';
    for (const img of images) {
      await pgQuery(sqlInsertImages, [projectId, `/uploads/${img.filename}`]);
    }
    res.status(200).json({ message: 'Project and images updated successfully' });
  } catch (err) {
    console.error('Error updating project:', err);
    res.status(500).json({ message: 'Error updating project', error: err });
  }
});

// DELETE project and its images by id
app.delete('/api/projects/:id', async (req, res) => {
  const projectId = req.params.id;
  try {
    const sqlSelectImages = 'SELECT image_url FROM project_images WHERE project_id = $1';
    const images = await pgQuery(sqlSelectImages, [projectId]);
    const imageUrls = images.map(row => row.image_url);
    deleteFiles(imageUrls);
    const sqlDeleteImages = 'DELETE FROM project_images WHERE project_id = $1';
    await pgQuery(sqlDeleteImages, [projectId]);
    const sqlDeleteProject = 'DELETE FROM projects WHERE id = $1';
    await pgQuery(sqlDeleteProject, [projectId]);
    res.status(200).json({ message: 'Project and images deleted successfully' });
  } catch (err) {
    console.error('Error deleting project:', err);
    res.status(500).json({ message: 'Error deleting project', error: err });
  }
});


// === Scroll Images ===

// Add scroll images (unlimited)
app.post('/api/scroll-images', upload.array('images'), async (req, res) => {
  const images = req.files;
  if (!images || images.length === 0) {
    return res.status(400).json({ message: 'No images uploaded' });
  }
  try {
    const sql = 'INSERT INTO scroll_images (image_url) VALUES ($1)';
    for (const img of images) {
      await pgQuery(sql, [`/uploads/${img.filename}`]);
    }
    res.status(200).json({ message: 'Scroll images uploaded successfully!' });
  } catch (err) {
    res.status(500).json({ message: 'Error saving scroll images', error: err });
  }
});

// Delete scroll image by id
app.delete('/api/scroll-images/:id', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // Explicit CORS header
  const imageId = req.params.id;
  try {
    const sqlSelect = 'SELECT image_url FROM scroll_images WHERE id = $1';
    const results = await pgQuery(sqlSelect, [imageId]);
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(404).json({ message: 'Scroll image not found' });
    }
    const imageUrl = results[0].image_url;
    const filepath = path.join(__dirname, imageUrl);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
    const sqlDelete = 'DELETE FROM scroll_images WHERE id = $1';
    await pgQuery(sqlDelete, [imageId]);
    return res.status(200).json({ message: 'Scroll image deleted successfully' });
  } catch (err) {
    console.error('Error deleting scroll image:', err);
    return res.status(500).json({ message: 'Error deleting scroll image', error: err.toString() });
  }
});
// GET all scroll images
app.get('/api/scroll-images', async (req, res) => {
  const sql = 'SELECT id, image_url FROM scroll_images ORDER BY id DESC';
  try {
    const results = await pgQuery(sql);
    res.json(results);
  } catch (err) {
    console.error('Error fetching scroll images:', err);
    res.status(500).json({ message: 'Failed to fetch scroll images', error: err });
  }
});



// === Videos ===

// Add video URL
app.post('/api/videos', async (req, res) => {
  const { video_url } = req.body;
  if (!video_url || video_url.trim() === '') {
    return res.status(400).json({ message: 'Video URL is required' });
  }
  try {
    const sql = 'INSERT INTO videos (video_url) VALUES ($1) RETURNING id';
    const result = await pgQuery(sql, [video_url.trim()]);
    res.status(200).json({ message: 'Video URL added successfully', videoId: result[0].id });
  } catch (err) {
    console.error('Error inserting video URL:', err);
    res.status(500).json({ message: 'Error inserting video URL', error: err.toString() });
  }
});

// Delete video by id
app.delete('/api/videos/:id', async (req, res) => {
  const videoId = req.params.id;
  try {
    const sqlDelete = 'DELETE FROM videos WHERE id = $1';
    const result = await pgQuery(sqlDelete, [videoId]);
    // PostgreSQL returns an array, but we can check if the video existed by checking affected rows
    // However, pgQuery returns rows, so we need to check if the video existed before deleting
    // Let's do a select first
    const sqlSelect = 'SELECT id FROM videos WHERE id = $1';
    const found = await pgQuery(sqlSelect, [videoId]);
    if (found.length === 0) {
      return res.status(404).json({ message: 'Video not found' });
    }
    await pgQuery(sqlDelete, [videoId]);
    res.status(200).json({ message: 'Video deleted successfully' });
  } catch (err) {
    console.error('Error deleting video:', err);
    res.status(500).json({ message: 'Error deleting video', error: err.toString() });
  }
});
// GET all videos (with `url` key and embedded YouTube link)
app.get('/api/videos', async (req, res) => {
  const sql = 'SELECT id, video_url FROM videos ORDER BY id DESC';
  try {
    const results = await pgQuery(sql);
    const formatted = results.map(video => {
      let embedUrl = video.video_url;
      // Convert YouTube normal link to embed format if it's a YouTube watch URL
      const match = embedUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
      if (match) {
        const videoId = match[1];
        embedUrl = `https://www.youtube.com/embed/${videoId}`;
      }
      return {
        id: video.id,
        url: embedUrl,
        title: 'Watch Video'
      };
    });
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching videos', error: err });
  }
});

// Add authentication endpoints using PostgreSQL
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password required' });
  }
  const hashedPassword = await bcrypt.hash(password, 10);
  try {
    await pgQuery('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hashedPassword]);
    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    if (err.code === '23505') {
      res.status(400).json({ message: 'Username already exists' });
    } else {
      res.status(500).json({ message: 'Error registering user', error: err });
    }
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password required' });
  }
  try {
    const result = await pgQuery('SELECT * FROM users WHERE username = $1', [username]);
    if (result.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const user = result[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    res.status(200).json({ message: 'Login successful' });
  } catch (err) {
    res.status(500).json({ message: 'Error logging in', error: err });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
