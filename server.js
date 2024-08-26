// server.js
const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const { Pool } = require('pg');  // Use pg for PostgreSQL
require('dotenv').config();
const SECRET_KEY = process.env.SECRET_KEY || 'your-secret-key';
const app = express();
const PORT = process.env.PORT || 5000;
const cors = require('cors');

const corsOptions = {
  origin: 'https://study-manager-eight.vercel.app',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));
// PostgreSQL connection using Neon
const pool = new Pool({
  connectionString: "postgresql://184mc1:xau_Mpv6k2HvmvneR2y3sj7X5epXneLEjFhS2@us-east-1.sql.xata.sh/study-manager:main?sslmode=require",
  ssl: {
    rejectUnauthorized: false // Necessary for connecting to Neon, which uses SSL by default
  }
});



app.use(bodyParser.json());

// Create tables if they don't exist
const createTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS Users (
      xata_id TEXT UNIQUE NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS Subjects (
      xata_id TEXT UNIQUE NOT NULL,
      name TEXT UNIQUE NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS Chapters (
      xata_id TEXT UNIQUE NOT NULL,
      subject_id TEXT REFERENCES Subjects(xata_id),
      name TEXT,
      UNIQUE(subject_id, name)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS Lectures (
      xata_id TEXT UNIQUE NOT NULL,
      chapter_id TEXT REFERENCES Chapters(xata_id),
      user_id TEXT REFERENCES Users(xata_id),
      name TEXT,
      file_path TEXT,
      watched BOOLEAN DEFAULT false,
      duration TEXT DEFAULT 0,
      UNIQUE(chapter_id, user_id, name)
    )
  `);
};

createTables();

// Register new user and populate their lectures
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO Users (username, password) VALUES ($1, $2) RETURNING xata_id',
      [username, hashedPassword]
    );
    const userId = result.rows[0].id;
    await populateUserLecturesFromExistingData(userId);
    res.json({ id: userId, username });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Error during registration' });
  }
});

// Populate lectures for a new user based on existing subjects and chapters
// Populate lectures for a new user based on existing subjects and chapters
async function populateUserLecturesFromExistingData(userId) {
  try {
    const chapters = await pool.query('SELECT * FROM Chapters');

    for (const chapter of chapters.rows) {
      const lectures = await pool.query('SELECT * FROM Lectures WHERE chapter_id = $1', [chapter.id]);

      if (lectures.rows.length > 0) {
        const insertValues = lectures.rows.map(lecture => `(${chapter.id}, ${userId}, '${lecture.name.replace(/'/g, "''")}', '${lecture.file_path.replace(/'/g, "''")}', false, ${lecture.duration})`).join(',');

        const insertQuery = `
          INSERT INTO Lectures (chapter_id, user_id, name, file_path, watched, duration)
          VALUES ${insertValues}
          ON CONFLICT (chapter_id, user_id, name)
          DO NOTHING;
        `;
        await pool.query(insertQuery);
      }
    }
  } catch (err) {
    console.error('Error populating user lectures:', err);
  }
}


// Login existing user
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM Users WHERE username = $1', [username]);
    const user = result.rows[0];

    if (!user) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: '1h' });
    
    // Call populateUserLecturesFromExistingData, but don't respond here
    await populateUserLecturesFromExistingData(user.id);

    // Respond with the token after everything is done
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Authenticate token middleware
function authenticateToken(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Access denied' });

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// Fetch subjects
app.get('/api/subjects', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM Subjects');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Fetch chapters by subject
app.get('/api/subjects/:subjectId/chapters', authenticateToken, async (req, res) => {
  const { subjectId } = req.params;
  try {
    const result = await pool.query('SELECT * FROM Chapters WHERE subject_id = $1', [subjectId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Fetch lectures by chapter
app.get('/api/chapters/:chapterId/lectures', authenticateToken, async (req, res) => {
  const { chapterId } = req.params;
  try {
    const result = await pool.query(
      `SELECT Lectures.*, Subjects.name AS subject_name, Chapters.name AS chapter_name
       FROM Lectures
       JOIN Chapters ON Lectures.chapter_id = Chapters.id
       JOIN Subjects ON Chapters.subject_id = Subjects.id
       WHERE Lectures.chapter_id = $1 AND Lectures.user_id = $2
       ORDER BY Lectures.name`,
      [chapterId, req.user.id]
    );

    const lecturesWithFilePath = result.rows.map(lecture => {
      let filePath;
   
        filePath = lecture.file_path;  // Use the YouTube URL as-is
      return {
        ...lecture,
        file_path: filePath
      };
    });

    res.json(lecturesWithFilePath);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Toggle watched status of a lecture
app.put('/api/lectures/:lectureId/toggle-watched', authenticateToken, async (req, res) => {
  const { lectureId } = req.params;
  try {
    const result = await pool.query('SELECT watched FROM Lectures WHERE xata_id = $1 AND user_id = $2', [lectureId, req.user.id]);
    const lecture = result.rows[0];

    if (!lecture) {
      return res.status(404).json({ error: 'Lecture not found' });
    }

    const newWatchedStatus = !lecture.watched;
    await pool.query('UPDATE Lectures SET watched = $1 WHERE xata_id = $2', [newWatchedStatus, lectureId]);
    res.json({ id: lectureId, watched: newWatchedStatus });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Get total duration of watched and all lectures in a chapter
app.get('/api/chapters/:chapterId/duration', authenticateToken, async (req, res) => {
  const { chapterId } = req.params;
  try {
    const result = await pool.query(
      `SELECT
          SUM(duration * CASE WHEN watched THEN 1 ELSE 0 END) AS watched_duration,
          SUM(duration) AS total_duration
       FROM Lectures
       WHERE chapter_id = $1 AND user_id = $2`,
      [chapterId, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Get total duration of watched and all lectures in a subject
app.get('/api/subjects/:subjectId/duration', authenticateToken, async (req, res) => {
  const { subjectId } = req.params;
  try {
    const result = await pool.query(
      `SELECT
          SUM(CASE WHEN Lectures.watched THEN Lectures.duration ELSE 0 END) AS watched_duration,
          SUM(Lectures.duration) AS total_duration
       FROM Lectures
       JOIN Chapters ON Lectures.chapter_id = Chapters.id
       WHERE Chapters.subject_id = $1 AND Lectures.user_id = $2`,
      [subjectId, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Serve static files
app.use('/lectures', express.static(path.join(__dirname, 'lectures')));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
