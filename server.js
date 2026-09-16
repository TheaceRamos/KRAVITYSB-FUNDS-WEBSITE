const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================================================
   REQUIRED ENVIRONMENT
========================================================= */

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

if (!process.env.SESSION_SECRET) {
  console.error("SESSION_SECRET is not set.");
  process.exit(1);
}

/*
   ADMIN_EMAIL is intentionally optional.

   If ADMIN_EMAIL is not configured on Render,
   admin endpoints remain disabled.

   Later, set ADMIN_EMAIL to the email address
   of the account that should manage withdrawals.
*/
const ADMIN_EMAIL = String(
  process.env.ADMIN_EMAIL || ""
).trim().toLowerCase();

/* =========================================================
   SHASTA TESTNET
========================================================= */

const DEPOSIT_ADDRESS =
  "TYyHGjz9jwUM6bqsqaNqwhFqRoTtdQj49x";

const TRONGRID =
  "https://api.shasta.trongrid.io";

const USDT_TEST_CONTRACT =
  "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs";

/* =========================================================
   DATABASE
========================================================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* =========================================================
   EXPRESS
========================================================= */

app.set("trust proxy", 1);

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true
  })
);

/* =========================================================
   SESSIONS
========================================================= */

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

/* =========================================================
   DATABASE SETUP
========================================================= */

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,
      amount NUMERIC(30,6) NOT NULL,
      destination VARCHAR(64) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("Database ready.");
}

/* =========================================================
   AUTH MIDDLEWARE
========================================================= */

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      success: false,
      message: "Please log in first."
    });
  }

  next();
}

/* =========================================================
   ADMIN MIDDLEWARE
========================================================= */

async function requireAdmin(req, res, next) {
  try {
    if (!req.session.userId) {
      return res.status(401).json({
        success: false,
        message: "Please log in first."
      });
    }

    if (!ADMIN_EMAIL) {
      return res.status(403).json({
        success: false,
        message: "Admin access is not configured."
      });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        full_name,
        email
      FROM users
      WHERE id = $1
      `,
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({
        success: false,
        message: "Admin access denied."
      });
    }

    const user = result.rows[0];

    if (
      String(user.email).trim().toLowerCase() !==
      ADMIN_EMAIL
    ) {
      return res.status(403).json({
        success: false,
        message: "Admin access denied."
      });
    }

    req.adminUser = user;

    next();
  } catch (error) {
    console.error("Admin authentication error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to verify admin access."
    });
  }
}

/* =========================================================
   CONFIG
========================================================= */

app.get("/api/config", (req, res) => {
  res.json({
    network: "TRON Shasta Testnet",

    depositAddress:
      DEPOSIT_ADDRESS,

    usdtContract:
      USDT_TEST_CONTRACT,

    testnetOnly: true
  });
});

/* =========================================================
   SHASTA DEPOSITS
========================================================= */

app.get("/api/deposits", async (req, res) => {
  try {
    const url =
      `${TRONGRID}/v1/accounts/` +
      `${DEPOSIT_ADDRESS}/transactions/trc20`;

    const response = await fetch(
      url +
      "?only_confirmed=true&limit=50&order_by=block_timestamp,desc"
    );

    if (!response.ok) {
      throw new Error(
        `TronGrid returned ${response.status}`
      );
    }

    const data = await response.json();

    const transfers =
      (data.data || []).filter((x) => {
        const tokenAddress =
          String(
            x.token_info?.address || ""
          ).toLowerCase();

        const recipient =
          String(
            x.to || ""
          ).toLowerCase();

        return (
          tokenAddress ===
          USDT_TEST_CONTRACT.toLowerCase()
          &&
          recipient ===
          DEPOSIT_ADDRESS.toLowerCase()
        );
      });

    res.json({
      network: "Shasta",
      deposits: transfers
    });
  } catch (error) {
    console.error(
      "Shasta deposit lookup error:",
      error
    );

    res.status(502).json({
      error:
        "Could not read Shasta testnet data"
    });
  }
});

/* =========================================================
   CREATE WITHDRAWAL
========================================================= */

app.post(
  "/api/withdrawals",
  requireLogin,
  async (req, res) => {
    try {
      const {
        amount,
        destination
      } = req.body || {};

      const numericAmount =
        Number(amount);

      if (
        !Number.isFinite(numericAmount) ||
        numericAmount <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Enter a valid withdrawal amount."
        });
      }

      if (
        numericAmount > 1000000
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Test withdrawal amount is too large."
        });
      }

      if (
        !destination ||
        !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(
          destination
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Enter a valid TRON address."
        });
      }

      const result =
        await pool.query(
          `
          INSERT INTO withdrawals
          (
            user_id,
            amount,
            destination,
            status
          )
          VALUES
          ($1, $2, $3, 'pending')
          RETURNING
            id,
            amount,
            destination,
            status,
            created_at
          `,
          [
            req.session.userId,
            numericAmount,
            destination
          ]
        );

      res.status(201).json({
        success: true,

        message:
          "Withdrawal request created and saved as pending.",

        withdrawal:
          result.rows[0]
      });
    } catch (error) {
      console.error(
        "Withdrawal error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to create withdrawal request."
      });
    }
  }
);

/* =========================================================
   USER WITHDRAWAL HISTORY
========================================================= */

app.get(
  "/api/withdrawals",
  requireLogin,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT
            id,
            amount,
            destination,
            status,
            created_at
          FROM withdrawals
          WHERE user_id = $1
          ORDER BY created_at DESC
          `,
          [req.session.userId]
        );

      res.json({
        success: true,
        withdrawals:
          result.rows
      });
    } catch (error) {
      console.error(
        "Withdrawal history error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to load withdrawal history."
      });
    }
  }
);

/* =========================================================
   ADMIN - GET ALL WITHDRAWALS
========================================================= */

app.get(
  "/api/admin/withdrawals",
  requireAdmin,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT
            w.id,
            w.user_id,
            u.full_name,
            u.email,
            w.amount,
            w.destination,
            w.status,
            w.created_at
          FROM withdrawals w
          JOIN users u
            ON u.id = w.user_id
          ORDER BY
            w.created_at DESC
          `
        );

      res.json({
        success: true,
        testnet: true,
        withdrawals:
          result.rows
      });
    } catch (error) {
      console.error(
        "Admin withdrawal list error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to load admin withdrawals."
      });
    }
  }
);

/* =========================================================
   ADMIN - UPDATE WITHDRAWAL STATUS
========================================================= */

app.patch(
  "/api/admin/withdrawals/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const withdrawalId =
        Number(req.params.id);

      if (
        !Number.isInteger(withdrawalId) ||
        withdrawalId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid withdrawal ID."
        });
      }

      const requestedStatus =
        String(
          req.body?.status || ""
        )
          .trim()
          .toLowerCase();

      const allowedStatuses = [
        "pending",
        "processing",
        "approved",
        "rejected",
        "cancelled",
        "completed"
      ];

      if (
        !allowedStatuses.includes(
          requestedStatus
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid withdrawal status."
        });
      }

      const result =
        await pool.query(
          `
          UPDATE withdrawals
          SET status = $1
          WHERE id = $2
          RETURNING
            id,
            user_id,
            amount,
            destination,
            status,
            created_at
          `,
          [
            requestedStatus,
            withdrawalId
          ]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Withdrawal not found."
        });
      }

      res.json({
        success: true,
        testnet: true,

        message:
          "Withdrawal status updated.",

        withdrawal:
          result.rows[0]
      });
    } catch (error) {
      console.error(
        "Admin withdrawal update error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to update withdrawal status."
      });
    }
  }
);

/* =========================================================
   ADMIN - APPROVE WITHDRAWAL
========================================================= */

app.post(
  "/api/admin/withdrawals/:id/approve",
  requireAdmin,
  async (req, res) => {
    try {
      const withdrawalId =
        Number(req.params.id);

      if (
        !Number.isInteger(withdrawalId) ||
        withdrawalId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid withdrawal ID."
        });
      }

      const result =
        await pool.query(
          `
          UPDATE withdrawals
          SET status = 'approved'
          WHERE id = $1
          RETURNING
            id,
            user_id,
            amount,
            destination,
            status,
            created_at
          `,
          [withdrawalId]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Withdrawal not found."
        });
      }

      res.json({
        success: true,
        testnet: true,

        message:
          "Withdrawal approved for testnet processing.",

        withdrawal:
          result.rows[0]
      });
    } catch (error) {
      console.error(
        "Admin approve error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to approve withdrawal."
      });
    }
  }
);

/* =========================================================
   ADMIN - REJECT WITHDRAWAL
========================================================= */

app.post(
  "/api/admin/withdrawals/:id/reject",
  requireAdmin,
  async (req, res) => {
    try {
      const withdrawalId =
        Number(req.params.id);

      if (
        !Number.isInteger(withdrawalId) ||
        withdrawalId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid withdrawal ID."
        });
      }

      const result =
        await pool.query(
          `
          UPDATE withdrawals
          SET status = 'rejected'
          WHERE id = $1
          RETURNING
            id,
            user_id,
            amount,
            destination,
            status,
            created_at
          `,
          [withdrawalId]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Withdrawal not found."
        });
      }

      res.json({
        success: true,
        testnet: true,

        message:
          "Withdrawal rejected.",

        withdrawal:
          result.rows[0]
      });
    } catch (error) {
      console.error(
        "Admin reject error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to reject withdrawal."
      });
    }
  }
);

/* =========================================================
   SIGN UP
========================================================= */

app.post(
  "/api/signup",
  async (req, res) => {
    try {
      const {
        fullName,
        email,
        password,
        confirmPassword
      } = req.body;

      if (
        !fullName ||
        !email ||
        !password ||
        !confirmPassword
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Please fill in all fields."
        });
      }

      if (
        password !== confirmPassword
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Passwords do not match."
        });
      }

      if (
        password.length < 8
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Password must be at least 8 characters."
        });
      }

      const cleanEmail =
        email
          .trim()
          .toLowerCase();

      const cleanName =
        fullName.trim();

      const existing =
        await pool.query(
          `
          SELECT id
          FROM users
          WHERE email = $1
          `,
          [cleanEmail]
        );

      if (
        existing.rows.length > 0
      ) {
        return res.status(409).json({
          success: false,
          message:
            "An account with this email already exists."
        });
      }

      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );

      const result =
        await pool.query(
          `
          INSERT INTO users
          (
            full_name,
            email,
            password_hash
          )
          VALUES
          ($1, $2, $3)
          RETURNING
            id,
            full_name,
            email
          `,
          [
            cleanName,
            cleanEmail,
            passwordHash
          ]
        );

      res.status(201).json({
        success: true,

        message:
          "Account created successfully.",

        user:
          result.rows[0]
      });
    } catch (error) {
      console.error(
        "Signup error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to create account."
      });
    }
  }
);

/* =========================================================
   LOGIN
========================================================= */

app.post(
  "/api/login",
  async (req, res) => {
    try {
      const {
        email,
        password
      } = req.body;

      if (
        !email ||
        !password
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Please enter your email and password."
        });
      }

      const cleanEmail =
        email
          .trim()
          .toLowerCase();

      const result =
        await pool.query(
          `
          SELECT
            id,
            full_name,
            email,
            password_hash
          FROM users
          WHERE email = $1
          `,
          [cleanEmail]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(401).json({
          success: false,
          message:
            "Invalid email or password."
        });
      }

      const user =
        result.rows[0];

      const validPassword =
        await bcrypt.compare(
          password,
          user.password_hash
        );

      if (!validPassword) {
        return res.status(401).json({
          success: false,
          message:
            "Invalid email or password."
        });
      }

      req.session.userId =
        user.id;

      res.json({
        success: true,

        message:
          "Login successful.",

        user: {
          id:
            user.id,

          full_name:
            user.full_name,

          email:
            user.email
        }
      });
    } catch (error) {
      console.error(
        "Login error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to log in."
      });
    }
  }
);

/* =========================================================
   CURRENT USER
========================================================= */

app.get(
  "/api/me",
  async (req, res) => {
    try {
      if (
        !req.session.userId
      ) {
        return res.json({
          loggedIn: false
        });
      }

      const result =
        await pool.query(
          `
          SELECT
            id,
            full_name,
            email
          FROM users
          WHERE id = $1
          `,
          [req.session.userId]
        );

      if (
        result.rows.length === 0
      ) {
        req.session.destroy(
          () => {}
        );

        return res.json({
          loggedIn: false
        });
      }

      const user =
        result.rows[0];

      res.json({
        loggedIn: true,

        user: user,

        isAdmin:
          Boolean(
            ADMIN_EMAIL &&
            String(user.email)
              .trim()
              .toLowerCase() ===
            ADMIN_EMAIL
          )
      });
    } catch (error) {
      console.error(
        "Session error:",
        error
      );

      res.status(500).json({
        loggedIn: false
      });
    }
  }
);

/* =========================================================
   LOGOUT
========================================================= */

app.post(
  "/api/logout",
  (req, res) => {
    req.session.destroy(
      (error) => {
        if (error) {
          return res.status(500).json({
            success: false,
            message:
              "Unable to log out."
          });
        }

        res.clearCookie(
          "connect.sid"
        );

        res.json({
          success: true,
          message:
            "Logged out."
        });
      }
    );
  }
);

/* =========================================================
   WEBSITE
========================================================= */

app.use(
  express.static(__dirname)
);

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );
  }
);

/* =========================================================
   START SERVER
========================================================= */

setupDatabase()
  .then(() => {
    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `Server running on port ${PORT}`
        );

        if (ADMIN_EMAIL) {
          console.log(
            "Admin withdrawal management is configured."
          );
        } else {
          console.log(
            "Admin withdrawal management is not configured yet."
          );
        }
      }
    );
  })
  .catch((error) => {
    console.error(
      "Database setup failed:",
      error
    );

    process.exit(1);
  });
