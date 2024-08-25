// server.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_KEY = process.env.SECRET_KEY || 'your-secret-key';

// Update CORS configuration to allow all origins
app.use(cors({
  origin: '*',
  credentials: true,
  exposedHeaders: ['Authorization'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json());

const db = new sqlite3.Database('study-manager.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS Users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS Subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS Chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER,
    name TEXT,
    UNIQUE(subject_id, name),
    FOREIGN KEY (subject_id) REFERENCES Subjects(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS Lectures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id INTEGER,
    user_id INTEGER,
    name TEXT,
    file_path TEXT,
    watched BOOLEAN DEFAULT false,
    duration INTEGER DEFAULT 0,
    UNIQUE(chapter_id, user_id, name),
    FOREIGN KEY (chapter_id) REFERENCES Chapters(id),
    FOREIGN KEY (user_id) REFERENCES Users(id)
  )`);
});

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  bcrypt.hash(password, 10, (err, hashedPassword) => {
    if (err) {
      return res.status(500).json({ error: 'Error hashing password' });
    }

    db.run(`INSERT INTO Users (username, password) VALUES (?, ?)`, [username, hashedPassword], function(err) {
      if (err) {
        return res.status(400).json({ error: 'Error during registration' });
      }

      const userId = this.lastID;
      scanAndPopulateUserLectures(userId);
      res.json({ id: userId, username });
    });
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM Users WHERE username = ?`, [username], (err, user) => {
    if (!user) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    bcrypt.compare(password, user.password, (err, match) => {
      if (!match) {
        return res.status(400).json({ error: 'Invalid username or password' });
      }

      const token = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: '1h' });
      res.json({ token });
    });
  });
});

function authenticateToken(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Access denied' });

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

app.get('/api/subjects', authenticateToken, (req, res) => {
  db.all(`SELECT * FROM Subjects`, [], (err, subjects) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    res.json(subjects);
  });
});

app.get('/api/subjects/:subjectId/chapters', authenticateToken, (req, res) => {
  const { subjectId } = req.params;
  db.all(`SELECT * FROM Chapters WHERE subject_id = ?`, [subjectId], (err, chapters) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    res.json(chapters);
  });
});

app.get('/api/chapters/:chapterId/lectures', authenticateToken, (req, res) => {
  const { chapterId } = req.params;
  db.all(`SELECT Lectures.*, Subjects.name AS subject_name, Chapters.name AS chapter_name
          FROM Lectures
          JOIN Chapters ON Lectures.chapter_id = Chapters.id
          JOIN Subjects ON Chapters.subject_id = Subjects.id
          WHERE Lectures.chapter_id = ? AND Lectures.user_id = ?
          ORDER BY Lectures.name`, [chapterId, req.user.id], (err, lectures) => {
      if (err) {
          return res.status(400).json({ error: err.message });
      }

      const lecturesWithFilePath = lectures.map(lecture => {
          let filePath;
          if (lecture.subject_name.includes("YT")) {
              filePath = lecture.file_path;  // Use the YouTube URL as-is
          } else {
              const modifiedName = lecture.name.includes('#') ? lecture.name.replace(/#/g, '%23') : lecture.name;
              filePath = `/lectures/${lecture.subject_name}/${lecture.chapter_name}/${modifiedName}`;
          }
          return {
              ...lecture,
              file_path: filePath
          };
      });

      res.json(lecturesWithFilePath);
  });
});


app.put('/api/lectures/:lectureId/toggle-watched', authenticateToken, (req, res) => {
  const { lectureId } = req.params;
  db.get(`SELECT watched FROM Lectures WHERE id = ? AND user_id = ?`, [lectureId, req.user.id], (err, lecture) => {
    if (!lecture) {
      return res.status(404).json({ error: 'Lecture not found' });
    }

    const newWatchedStatus = !lecture.watched;
    db.run(`UPDATE Lectures SET watched = ? WHERE id = ?`, [newWatchedStatus, lectureId], (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      res.json({ id: lectureId, watched: newWatchedStatus });
    });
  });
});

app.get('/api/chapters/:chapterId/duration', authenticateToken, (req, res) => {
  const { chapterId } = req.params;
  db.get(`SELECT
            SUM(duration * CASE WHEN watched THEN 1 ELSE 0 END) AS watched_duration,
            SUM(duration) AS total_duration
          FROM Lectures
          WHERE chapter_id = ? AND user_id = ?`, [chapterId, req.user.id], (err, duration) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    res.json(duration);
  });
});

app.get('/api/subjects/:subjectId/duration', authenticateToken, (req, res) => {
  const { subjectId } = req.params;
  db.get(`SELECT
            SUM(CASE WHEN Lectures.watched THEN Lectures.duration ELSE 0 END) AS watched_duration,
            SUM(Lectures.duration) AS total_duration
          FROM Lectures
          JOIN Chapters ON Lectures.chapter_id = Chapters.id
          WHERE Chapters.subject_id = ? AND Lectures.user_id = ?`, [subjectId, req.user.id], (err, duration) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    res.json(duration);
  });
});

app.use('/lectures', express.static(path.join(__dirname, 'lectures')));

function scanAndPopulateUserLectures(userId) {
  const LECTURES_DIR = './lectures';
  fs.readdir(LECTURES_DIR, (err, subjects) => {
    if (err) {
      console.error('Error reading subjects directory:', err);
      return;
    }

    subjects.forEach(subject => {
      const subjectPath = path.join(LECTURES_DIR, subject);
      if (fs.lstatSync(subjectPath).isDirectory()) {
        db.get(`SELECT id FROM Subjects WHERE name = ?`, [subject], (err, row) => {
          if (!row) {
            db.run(`INSERT INTO Subjects (name) VALUES (?)`, [subject], function(err) {
              if (err) return console.error(err.message);
              processChapters(subjectPath, this.lastID, userId);
            });
          } else {
            processChapters(subjectPath, row.id, userId);
          }
        });
      }
    });
  });
}

function processLectures(chapterPath, chapterId, userId) {
  fs.readdir(chapterPath, (err, lectures) => {
    if (err) {
      console.error('Error reading lectures directory:', err);
      return;
    }

    lectures.sort();

    lectures.forEach(lecture => {
      const lecturePath = path.join(chapterPath, lecture);
      if (fs.lstatSync(lecturePath).isFile() && path.extname(lecture) === '.mp4') {
        const lectureDuration = getLectureDuration(lecturePath);
        db.get(`SELECT id FROM Lectures WHERE chapter_id = ? AND user_id = ? AND name = ?`, [chapterId, userId, lecture], (err, row) => {
          if (!row) {
            db.run(`INSERT INTO Lectures (chapter_id, user_id, name, file_path, watched, duration) VALUES (?, ?, ?, ?, ?, ?)`,
              [chapterId, userId, lecture, lecturePath, false, lectureDuration]);
          }
        });
      }
    });
  });
}

function processChapters(subjectPath, subjectId, userId) {
  fs.readdir(subjectPath, (err, chapters) => {
    if (err) {
      console.error('Error reading chapters directory:', err);
      return;
    }

    chapters.forEach(chapter => {
      const chapterPath = path.join(subjectPath, chapter);
      if (fs.lstatSync(chapterPath).isDirectory()) {
        db.get(`SELECT id FROM Chapters WHERE subject_id = ? AND name = ?`, [subjectId, chapter], (err, row) => {
          if (!row) {
            db.run(`INSERT INTO Chapters (subject_id, name) VALUES (?, ?)`, [subjectId, chapter], function(err) {
              if (err) return console.error(err.message);
              processLectures(chapterPath, this.lastID, userId);
            });
          } else {
            processLectures(chapterPath, row.id, userId);
          }
        });
      }
    });
  });
}

function getLectureDuration(filePath) {
  try {
    const duration = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, { encoding: 'utf8' });
    return Math.round(parseFloat(duration.trim()));
  } catch (error) {
    console.error('Error getting lecture duration:', error);
    return 0;
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
