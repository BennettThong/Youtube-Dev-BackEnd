const cors = require('cors');
const express = require('express');
const mongoose = require('mongoose');
const { Pool } = require('pg');
require('dotenv').config();
const jwt = require('jsonwebtoken');
const multer = require('multer');
const admin = require('firebase-admin');
const path = require('path');
const axios = require('axios');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Load main .env (committed safe keys)
dotenv.config();

// Load .env.local (ignored, sensitive keys)
dotenv.config({ path: '.env.local' });


// Firebase Admin Setup
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
} else {
  serviceAccount = require('./serviceAccountKey.json');
}
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'dev-7526d.firebasestorage.app', // replace with your actual bucket name
});
const bucket = admin.storage().bucket();


// Middleware
const allowedOrigins = [
  "https://youtube-dev-finalized.vercel.app",
  "http://localhost:5173",
  "http://localhost:5000"
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("❌ Not allowed by CORS: " + origin));
    }
  },
  credentials: true
}));

app.use(express.json());



// ------------------- MongoDB Connection -------------------
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => console.error("❌ MongoDB error:", err));

// ------------------- PostgreSQL (Neon) Connection -------------------
const pool = new Pool({
  connectionString: process.env.POSTGRES_URI,
  ssl: { rejectUnauthorized: false }, // Required for Neon
});

// Optional: Just check version on first request
app.get("/db-version", async (req, res) => {
  try {
    const result = await pool.query("SELECT version()");
    res.send(result.rows[0]);
  } catch (err) {
    console.error("PostgreSQL version check failed:", err);
    res.status(500).send("Database not available");
  }
});



// ------------------- Shutdown Hook -------------------
process.on('SIGTERM', () => {
  pool.end(() => {
    console.log('🛑 PostgreSQL pool closed');
  });
});
// ------------------- Routes -------------------

app.get('/health', (req, res) => {
  res.send("🟢 Backend is running. Both DBs connected.");
});

app.get('/', (req, res) => {
  res.send("Hello from backend with MongoDB + PostgreSQL!");
});

app.post('/posts', async (req, res) => {
  const { title, content, user_id } = req.body;
  const client = await pool.connect();
  try {
    const userExists = await client.query('SELECT id FROM users WHERE id = $1', [user_id]);
    if (userExists.rows.length > 0) {
      const post = await client.query('INSERT INTO posts (title, content, user_id, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING *', [title, content, user_id]);
      res.json(post.rows[0]);
    } else {
      res.status(400).json({ error: "User does not exist" });
    }
  } catch (err) {
    console.log(err.stack);
    res.status(500).json({ error: "Something went wrong, please try again later!" });
  } finally {
    client.release();
  }
});

app.post('/likes', async (req, res) => {
  const { user_id, post_id } = req.body;
  const client = await pool.connect();
  try {
    const newLike = await client.query('INSERT INTO likes (user_id, post_id, created_at) VALUES ($1, $2, CURRENT_TIMESTAMP) RETURNING *', [user_id, post_id]);
    res.json(newLike.rows[0]);
  } catch (err) {
    console.log(err.stack);
    res.status(500).send('An error occurred, please try again.');
  } finally {
    client.release();
  }
});

app.delete('/likes/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM likes WHERE id = $1', [id]);
    res.json({ message: "Like Deleted Successfully" });
  } catch (err) {
    console.log(err.stack);
    res.status(500).send('An error occurred, please try again.');
  } finally {
    client.release();
  }
});

app.get('/likes/post/:post_id', async (req, res) => {
  const { post_id } = req.params;
  const client = await pool.connect();
  try {
    const likes = await client.query(
      'SELECT users.username FROM likes INNER JOIN users ON likes.user_id = users.id WHERE likes.post_id = $1',
      [post_id]
    );
    res.json(likes.rows);
  } catch (err) {
    console.error(err.stack);
    res.status(500).send('An error occurred, please try again.');
  } finally {
    client.release();
  }
});

// SIGNUP ROUTE
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;

  const client = await pool.connect();
  try {
    console.log("🔍 Received signup:", { username, password });

    const userExists = await client.query("SELECT id FROM users WHERE email = $1", [username]);
    console.log("🧠 Existing user result:", userExists.rows);

    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: "User already exists" });
    }

    const newUser = await client.query(
      "INSERT INTO users (username, email, password, created_at) VALUES ($1, $1, $2, CURRENT_TIMESTAMP) RETURNING *",
      [username, password]
    );

    res.status(201).json({ message: "User created", user: newUser.rows[0] });
  } catch (err) {
    console.error(err.stack);
    res.status(500).json({ error: "Signup failed" });
  } finally {
    client.release();
  }
});

// LOGIN ROUTE
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const client = await pool.connect();

  try {
    const result = await client.query("SELECT * FROM users WHERE email = $1", [username]);

    if (result.rows.length === 0) {
      return res.status(401).json({ auth: false, error: "User not found" });
    }

    const user = result.rows[0];

    if (user.password !== password) {
      return res.status(401).json({ auth: false, error: "Incorrect password" });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.status(200).json({
      auth: true,
      token: token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email
      }
    });
  } catch (err) {
    console.error("❌ Login error:", err.stack);
    res.status(500).json({ error: "Login failed" });
  } finally {
    client.release();
  }
});

app.get("/api/search", async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "Missing query" });

  try {
    const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        part: "snippet",
        q: query,
        type: "video",
        maxResults: 12,
        key: process.env.YOUTUBE_API_KEY, // API key stays secret
      },
    });
    res.json(response.data.items);
  } catch (err) {
    console.error("YouTube API backend error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch videos" });
  }
});

app.post('/upload-profile', upload.single('image'), async (req, res) => {
  console.log("📩 /upload-profile hit");

  // Allow cross-origin requests from specific origins
  const origin = req.headers.origin;
  const allowedOrigins = [
    "http://localhost:5173",
    "https://youtube-dev-finalized.vercel.app"
  ];

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  const file = req.file;

  if (!file) {
    console.error("❌ No file uploaded (req.file is undefined)");
    return res.status(400).json({ error: "No file uploaded" });
  }

  console.log("✅ File received:", {
    name: file.originalname,
    type: file.mimetype,
    size: file.size
  });

  try {
    const fileName = `profile-images/${Date.now()}-${file.originalname}`;
    const blob = bucket.file(fileName);

    const blobStream = blob.createWriteStream({
      metadata: {
        contentType: file.mimetype,
      },
    });

    blobStream.on("error", (err) => {
      console.error("❌ Upload stream error:", err);
      return res.status(500).json({ error: "Upload failed", details: err.message });
    });

    blobStream.on("finish", async () => {
      try {
        await blob.makePublic();
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`;
        console.log("✅ File uploaded successfully:", publicUrl);
        return res.status(200).json({ imageUrl: publicUrl });
      } catch (err) {
        console.error("❌ Failed to make file public:", err);
        return res.status(500).json({ error: "Failed to make file public", details: err.message });
      }
    });

    blobStream.end(file.buffer);
  } catch (err) {
    console.error("❌ Unexpected server error:", err);
    return res.status(500).json({ error: "Unexpected server error", details: err.message });
  }
});

const commentsRoutes = require("./routes/comments.routes")(pool, admin);
app.use("/api", commentsRoutes);







// ------------------- Shutdown Hook -------------------
process.on('SIGTERM', () => {
  pool.end(() => {
    console.log('🛑 PostgreSQL pool closed');
  });
});

// ------------------- Start Server -------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
