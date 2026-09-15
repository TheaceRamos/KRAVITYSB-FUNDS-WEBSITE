const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

if (!process.env.SESSION_SECRET) {
  console.error("SESSION_SECRET is not set.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.set("trust proxy", 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new pgSession({
      pool: pool,
      tableName: "user_sessions",
      createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

// Create users table
async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(100) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("Database ready.");
}

// SIGN UP
app.post("/api/signup", async (req, res) => {
  try {
    const { fullName, email, password, confirmPassword } = req.body;

    if (!fullName || !email || !password || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Please fill in all fields."
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Passwords do not match."
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters."
      });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = fullName.trim();

    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [cleanEmail]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (full_name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, full_name, email`,
      [cleanName, cleanEmail, passwordHash]
    );

    res.status(201).json({
      success: true,
      message: "Account created successfully.",
      user: result.rows[0]
    });

  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to create account."
    });
  }
});

// LOGIN
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Please enter your email and password."
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    const result = await pool.query(
      "SELECT id, full_name, email, password_hash FROM users WHERE email = $1",
      [cleanEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    const user = result.rows[0];

    const validPassword = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    req.session.userId = user.id;

    res.json({
      success: true,
      message: "Login successful.",
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email
      }
    });

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to log in."
    });
  }
});

// CURRENT USER
app.get("/api/me", async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.json({
        loggedIn: false
      });
    }

    const result = await pool.query(
      "SELECT id, full_name, email FROM users WHERE id = $1",
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      req.session.destroy(() => {});
      return res.json({
        loggedIn: false
      });
    }

    res.json({
      loggedIn: true,
      user: result.rows[0]
    });

  } catch (error) {
    console.error("Session error:", error);
    res.status(500).json({
      loggedIn: false
    });
  }
});

// LOGOUT
app.post("/api/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({
        success: false,
        message: "Unable to log out."
      });
    }

    res.clearCookie("connect.sid");
    res.json({
      success: true,
      message: "Logged out."
    });
  });
});

// Serve website files
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Start server
setupDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database setup failed:", error);
    process.exit(1);
  });
