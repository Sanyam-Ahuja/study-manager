// server.js
const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const SECRET_KEY = process.env.SECRET_KEY || 'your-secret-key';
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'], credentials: true }));
app.use(bodyParser.json());

const supabaseUrl = "https://ashrzqwhbvbxgrvvbxdr.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFzaHJ6cXdoYnZieGdydnZieGRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjQ2NzgwODYsImV4cCI6MjA0MDI1NDA4Nn0._HO8PGvO5YG5vVj-cJDJeT3eKL_6Ht6GVe987_xqoAY";
const supabase = createClient(supabaseUrl, supabaseKey);

// Register new user and populate their lectures
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase
      .from('Users')
      .insert([{ username, password: hashedPassword }])
      .select('*');

    if (error) throw error;

    const userId = user[0].id;
    await populateUserLecturesFromExistingData(userId);
    res.json({ id: userId, username });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Error during registration' });
  }
});

async function populateUserLecturesFromExistingData(userId) {
  try {
    const { data: chapters, error: chapterError } = await supabase
      .from('Chapters')
      .select('*');

    if (chapterError) throw chapterError;

    for (const chapter of chapters) {
      // Fetch existing user lectures for this chapter
      const { data: existingUserLectures, error: existingLecturesError } = await supabase
        .from('User_Lectures')
        .select('name')
        .eq('chapter_id', chapter.id)
        .eq('user_id', userId);

      if (existingLecturesError) throw existingLecturesError;

      // Extract the names of the existing lectures
      const existingLectureNames = existingUserLectures.map(lecture => lecture.name);

      // Fetch all lectures for this chapter
      const { data: lectures, error: lectureError } = await supabase
        .from('Lectures')
        .select('*')
        .eq('chapter_id', chapter.id);

      if (lectureError) throw lectureError;

      // Filter out lectures that already exist in User_Lectures
      const newLectures = lectures.filter(lecture => !existingLectureNames.includes(lecture.name));

      if (newLectures.length > 0) {
        const insertValues = newLectures.map(lecture => ({
          chapter_id: chapter.id,
          user_id: userId,
          name: lecture.name,
          file_path: lecture.file_path,
          watched: false,
          duration: lecture.duration
        }));

        const { error: insertError } = await supabase
          .from('User_Lectures')
          .insert(insertValues);

        if (insertError) throw insertError;
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
    const { data: users, error } = await supabase
      .from('Users')
      .select('*')
      .eq('username', username);

    if (error) throw error;

    const user = users[0];

    if (!user) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: '1h' });

    await populateUserLecturesFromExistingData(user.id);
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
    const { data: subjects, error } = await supabase
      .from('Subjects')
      .select('*');

    if (error) throw error;

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
    const { data: chapters, error } = await supabase
      .from('Chapters')
      .select('*')
      .eq('subject_id', subjectId);

    if (error) throw error;

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
    const { data: lectures, error } = await supabase
      .from('User_Lectures')
      .select('*')
      .eq('chapter_id', chapterId)
      .eq('user_id', req.user.id)
      .order('name');

    if (error) throw error;

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
    const { data: lecture, error } = await supabase
      .from('User_Lectures')
      .select('watched')
      .eq('id', lectureId)
      .eq('user_id', req.user.id)
      .single();

    if (error) throw error;

    const newWatchedStatus = !lecture.watched;
    const { error: updateError } = await supabase
      .from('User_Lectures')
      .update({ watched: newWatchedStatus })
      .eq('id', lectureId);

    if (updateError) throw updateError;

    res.json({ id: lectureId, watched: newWatchedStatus });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
  
});

app.get('/api/subjects/:subjectId/duration', authenticateToken, async (req, res) => {
  const { subjectId } = req.params;
  const userId = req.user.id;

  console.log(`Fetching durations for subjectId: ${subjectId}, userId: ${userId}`);

  try {
    // First, retrieve the chapter IDs associated with the subject
    const { data: chapters, error: chaptersError } = await supabase
      .from('Chapters')
      .select('id')
      .eq('subject_id', subjectId);

    if (chaptersError) throw chaptersError;

    const chapterIds = chapters.map(chapter => chapter.id);

    if (chapterIds.length === 0) {
      return res.json({ watched_duration: 0, total_duration: 0 });
    }

    // Now retrieve the lecture durations for the identified chapters
    const { data: lectures, error: lecturesError } = await supabase
      .from('User_Lectures')
      .select('duration, watched')
      .in('chapter_id', chapterIds)
      .eq('user_id', userId);

    if (lecturesError) throw lecturesError;

    const watchedDuration = lectures
      .filter(lecture => lecture.watched)
      .reduce((sum, lecture) => sum + lecture.duration, 0);

    const totalDuration = lectures
      .reduce((sum, lecture) => sum + lecture.duration, 0);

    console.log(`watchedDuration: ${watchedDuration}, totalDuration: ${totalDuration}`);

    res.json({ watched_duration: watchedDuration, total_duration: totalDuration });
  } catch (err) {
    console.error('Error calculating subject duration:', err);
    res.status(400).json({ error: err.message });
  }
});



function isValidUUID(uuid) {
  const regexExp = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return regexExp.test(uuid);
}






app.get('/api/chapters/:chapterId/duration', authenticateToken, async (req, res) => {
  const { chapterId } = req.params;
  const userId = req.user.id;

  try {
    const { data, error } = await supabase
      .from('User_Lectures')
      .select('duration, watched')
      .eq('chapter_id', chapterId)
      .eq('user_id', userId);

    if (error) throw error;

    // Log the data to check if it's being retrieved correctly
    console.log('Retrieved Lectures:', data);

    const watchedDuration = data
      .filter(lecture => lecture.watched)
      .reduce((sum, lecture) => sum + lecture.duration, 0);

    const totalDuration = data
      .reduce((sum, lecture) => sum + lecture.duration, 0);

    res.json({ watched_duration: watchedDuration, total_duration: totalDuration });
  } catch (err) {
    console.error('Error calculating chapter duration:', err);
    res.status(400).json({ error: err.message });
  }
});




// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
