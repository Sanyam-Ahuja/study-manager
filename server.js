const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const cors = require('cors');
require('dotenv').config();
const XataClient = require('@xata.io/client').default;



// Initialize the Xata client
const xata = new XataClient({
  apiKey: "xau_Mpv6k2HvmvneR2y3sj7X5epXneLEjFhS2",
  databaseURL: "https://Sanyam-Ahuja-s-workspace-184mc1.us-east-1.xata.sh/db/study-manager:main"
});

const SECRET_KEY = process.env.SECRET_KEY || 'your-secret-key';
const app = express();
const PORT = process.env.PORT || 5000;

const corsOptions = {
  origin: 'https://study-manager-eight.vercel.app',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(bodyParser.json());

// Register new user and populate their lectures
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert the user into the Xata 'Users' table
    const newUser = await xata.db.Users.create({
      username,
      password: hashedPassword
    });

    // Populate lectures for the new user
    await populateUserLecturesFromExistingData(newUser.xata_id);

    res.json({ id: newUser.xata_id, username });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Error during registration' });
  }
});

// Populate lectures for a new user based on existing subjects and chapters
async function populateUserLecturesFromExistingData(userId) {
  try {
    const chapters = await xata.db.Chapters.getAll();

    for (const chapter of chapters) {
      const lectures = await xata.db.Lectures.filter({ chapter_id: chapter.xata_id }).getMany();

      if (lectures.length > 0) {
        for (const lecture of lectures) {
          await xata.db.Lectures.create({
            chapter_id: chapter.xata_id,
            user_id: userId,
            name: lecture.name,
            file_path: lecture.file_path,
            watched: false,
            duration: lecture.duration || 0
          });
        }
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
    const user = await xata.db.Users.filter({ username }).getFirst();

    if (!user) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ id: user.xata_id }, SECRET_KEY, { expiresIn: '1h' });

    // Populate lectures for the user if needed
    await populateUserLecturesFromExistingData(user.xata_id);

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
    const subjects = await xata.db.Subjects.getAll();
    res.json(subjects);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Fetch chapters by subject
app.get('/api/subjects/:subjectId/chapters', authenticateToken, async (req, res) => {
  const { subjectId } = req.params;
  try {
    const chapters = await xata.db.Chapters.filter({ subject_id: subjectId }).getMany();
    res.json(chapters);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Fetch lectures by chapter
app.get('/api/chapters/:chapterId/lectures', authenticateToken, async (req, res) => {
  const { chapterId } = req.params;
  try {
    const lectures = await xata.db.Lectures.filter({ chapter_id: chapterId, user_id: req.user.id }).getMany();
    res.json(lectures);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Toggle watched status of a lecture
app.put('/api/lectures/:lectureId/toggle-watched', authenticateToken, async (req, res) => {
  const { lectureId } = req.params;
  try {
    const lecture = await xata.db.Lectures.read(lectureId);

    if (!lecture || lecture.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Lecture not found' });
    }

    const newWatchedStatus = !lecture.watched;
    await xata.db.Lectures.update(lectureId, { watched: newWatchedStatus });

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
    const lectures = await xata.db.Lectures.filter({ chapter_id: chapterId, user_id: req.user.id }).getMany();

    const watchedDuration = lectures.reduce((sum, lecture) => sum + (lecture.watched ? lecture.duration : 0), 0);
    const totalDuration = lectures.reduce((sum, lecture) => sum + lecture.duration, 0);

    res.json({ watched_duration: watchedDuration, total_duration: totalDuration });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Get total duration of watched and all lectures in a subject
app.get('/api/subjects/:subjectId/duration', authenticateToken, async (req, res) => {
  const { subjectId } = req.params;
  try {
    const chapters = await xata.db.Chapters.filter({ subject_id: subjectId }).getMany();
    const chapterIds = chapters.map(chapter => chapter.xata_id);

    const lectures = await xata.db.Lectures.filter({
      chapter_id: { $in: chapterIds },
      user_id: req.user.id
    }).getMany();

    const watchedDuration = lectures.reduce((sum, lecture) => sum + (lecture.watched ? lecture.duration : 0), 0);
    const totalDuration = lectures.reduce((sum, lecture) => sum + lecture.duration, 0);

    res.json({ watched_duration: watchedDuration, total_duration: totalDuration });
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
console.log(XataClient);
