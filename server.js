require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { randomUUID } = require("crypto");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "careerpath",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

async function ensureUsersTable() {
  const sql = `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    passwordHash VARCHAR(255) NOT NULL,
    role ENUM('seeker','employer') NOT NULL DEFAULT 'seeker',
    companyName VARCHAR(255),
    companyWebsite VARCHAR(255),
    companySize VARCHAR(64),
    createdAt DATETIME NOT NULL
  ) ENGINE=InnoDB`;
  await pool.query(sql);

  // Backward-compatible column adds
  const addCols = [
    "ADD COLUMN companyName VARCHAR(255) NULL",
    "ADD COLUMN companyWebsite VARCHAR(255) NULL",
    "ADD COLUMN companySize VARCHAR(64) NULL",
    "ADD COLUMN skills TEXT NULL"
  ];
  for (const clause of addCols) {
    try {
      await pool.query(`ALTER TABLE users ${clause}`);
    } catch (err) {
      if (err && err.code !== "ER_DUP_FIELDNAME") throw err;
    }
  }

  // Ensure 'admin' is part of the role enum (safe migration attempt)
  try {
    await pool.query("ALTER TABLE users MODIFY COLUMN role ENUM('seeker','employer','admin') NOT NULL DEFAULT 'seeker'");
  } catch (err) {
    // Ignore if already modified or incompatible; we'll still run with existing values
  }
}

async function ensureJobsTable() {
  const sql = `CREATE TABLE IF NOT EXISTS jobs (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    company VARCHAR(255) NOT NULL,
    location VARCHAR(255) NOT NULL,
    workType VARCHAR(64),
    salary INT NULL,
    seniority VARCHAR(64),
    summary TEXT,
    requiredSkills TEXT NOT NULL,
    applyUrl TEXT NOT NULL,
    createdAt DATETIME NOT NULL,
    owner_user_id VARCHAR(64),
    INDEX idx_owner (owner_user_id),
    CONSTRAINT fk_owner FOREIGN KEY (owner_user_id) REFERENCES users(id)
  ) ENGINE=InnoDB`;
  await pool.query(sql);

  // If column already existed, the FK may have failed previously; ensure column exists for older tables
  try {
    await pool.query("ALTER TABLE jobs ADD COLUMN owner_user_id VARCHAR(64) NULL");
  } catch (err) {
    if (err && err.code !== "ER_DUP_FIELDNAME") {
      throw err;
    }
  }
}

async function ensureAdminUser() {
  try {
    const adminEmail = "admin@gmail.com";
    const [rows] = await pool.query("SELECT id FROM users WHERE email = ? LIMIT 1", [adminEmail]);
    if (rows.length) return; // already exists

    const passwordHash = await bcrypt.hash("123456", 10);
    const user = {
      id: makeId(),
      name: "Admin",
      email: adminEmail,
      passwordHash,
      role: "admin",
      companyName: null,
      companyWebsite: null,
      companySize: null,
      createdAt: new Date()
    };
    await pool.query(
      `INSERT INTO users (id, name, email, passwordHash, role, companyName, companyWebsite, companySize, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [user.id, user.name, user.email, user.passwordHash, user.role, user.companyName, user.companyWebsite, user.companySize, user.createdAt]
    );
    console.log("Seeded default admin user:", adminEmail);
  } catch (err) {
    console.error("Failed to ensure admin user", err);
  }
}

function makeId() {
  if (typeof randomUUID === "function") return randomUUID();
  return `job_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

function setAuthCookie(res, token) {
  res.cookie("cp_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function clearAuthCookie(res) {
  res.cookie("cp_token", "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0
  });
}

function requireAuth(req, res, next) {
  const bearer = req.headers.authorization;
  let token = null;
  if (bearer && bearer.toLowerCase().startsWith("bearer ")) {
    token = bearer.slice(7);
  }
  if (!token && req.cookies?.cp_token) token = req.cookies.cp_token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (!req.user || req.user.role !== role) {
        return res.status(403).json({ error: `${role} role required` });
      }
      next();
    });
  };
}

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, role = "seeker", companyName = null, companyWebsite = null, companySize = null } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required." });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    const normalizedRole = ["employer", "admin"].includes(role) ? role : "seeker";

    const user = {
      id: makeId(),
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      passwordHash: await bcrypt.hash(password, 10),
      role: normalizedRole,
      companyName: companyName ? String(companyName).trim() : null,
      companyWebsite: companyWebsite ? String(companyWebsite).trim() : null,
      companySize: companySize ? String(companySize).trim() : null,
      createdAt: new Date()
    };

    await pool.query(
      `INSERT INTO users (id, name, email, passwordHash, role, companyName, companyWebsite, companySize, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [user.id, user.name, user.email, user.passwordHash, user.role, user.companyName, user.companyWebsite, user.companySize, user.createdAt]
    );

    const token = signToken({ id: user.id, email: user.email, role: user.role, name: user.name });
    setAuthCookie(res, token);
    res.status(201).json({ user: mapRowToUser(user) });
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Email already registered" });
    }
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }
    const [rows] = await pool.query("SELECT * FROM users WHERE email = ? LIMIT 1", [
      String(email).trim().toLowerCase()
    ]);
    if (!rows.length) return res.status(401).json({ error: "Invalid credentials" });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = signToken({ id: user.id, email: user.email, role: user.role, name: user.name });
    setAuthCookie(res, token);
    res.json({ user: mapRowToUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => {
  // Gracefully return null when unauthenticated to avoid noisy 401s on public pages
  let token = null;
  const bearer = req.headers.authorization;
  if (bearer && bearer.toLowerCase().startsWith("bearer ")) token = bearer.slice(7);
  if (!token && req.cookies?.cp_token) token = req.cookies.cp_token;
  if (!token) return res.json({ user: null });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const [rows] = await pool.query("SELECT id, name, email, role, skills, companyName, companyWebsite, companySize, createdAt FROM users WHERE id = ? LIMIT 1", [
      payload.id
    ]);
    if (!rows.length) return res.json({ user: null });
    res.json({ user: mapRowToUser(rows[0]) });
  } catch (err) {
    // Invalid/expired tokens yield null user instead of 401
    return res.json({ user: null });
  }
});

app.post("/api/user/skills", requireAuth, async (req, res) => {
  try {
    const { skills } = req.body || {};
    if (!Array.isArray(skills)) {
      return res.status(400).json({ error: "Skills must be an array" });
    }
    // Normalize: trim, then capitalize each word (handle multi-word skills like "Node JS")
    const normalized = skills.map(s => {
      const trimmed = String(s).trim();
      if (!trimmed) return null;
      // Capitalize first letter of each word, keep rest lowercase
      return trimmed.split(/\s+/).map(word => 
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      ).join(" ");
    }).filter(Boolean);
    const skillsText = normalized.join(",");
    await pool.query("UPDATE users SET skills = ? WHERE id = ?", [skillsText, req.user.id]);
    res.json({ ok: true, skills: normalized });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/jobs", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM jobs ORDER BY createdAt DESC"
    );
    const jobs = rows.map(mapRowToJob);
    res.json(jobs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ===================== ADMIN ENDPOINTS =====================
app.get("/api/admin/stats", requireRole("admin"), async (req, res) => {
  try {
    const [[usersTotalRow]] = await pool.query("SELECT COUNT(*) AS count FROM users");
    const usersTotal = usersTotalRow?.count ?? 0;

    const [roleRows] = await pool.query("SELECT role, COUNT(*) AS count FROM users GROUP BY role");
    const roles = { seeker: 0, employer: 0, admin: 0 };
    for (const r of roleRows) {
      roles[r.role] = r.count;
    }

    const [[jobsTotalRow]] = await pool.query("SELECT COUNT(*) AS count FROM jobs");
    const jobsTotal = jobsTotalRow?.count ?? 0;

    const [workTypeRows] = await pool.query("SELECT workType, COUNT(*) AS count FROM jobs GROUP BY workType");
    const jobsByWorkType = workTypeRows
      .filter(r => r.workType)
      .map(r => ({ workType: r.workType, count: r.count }));

    const [skillsRows] = await pool.query("SELECT skills FROM users WHERE skills IS NOT NULL AND skills <> ''");
    const tally = new Map();
    for (const row of skillsRows) {
      const parts = String(row.skills || "").split(",").map(s => s.trim()).filter(Boolean);
      for (const s of parts) {
        tally.set(s, (tally.get(s) || 0) + 1);
      }
    }
    const topSkills = Array.from(tally.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    res.json({ usersTotal, roles, jobsTotal, jobsByWorkType, topSkills });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/admin/jobs", requireRole("admin"), async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM jobs ORDER BY createdAt DESC");
    res.json(rows.map(mapRowToJob));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/admin/jobs/:id", requireRole("admin"), async (req, res) => {
  try {
    const jobId = req.params.id;
    const [rows] = await pool.query("SELECT * FROM jobs WHERE id = ? LIMIT 1", [jobId]);
    if (!rows.length) return res.status(404).json({ error: "Job not found" });
    await pool.query("DELETE FROM jobs WHERE id = ?", [jobId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/admin/users", requireRole("admin"), async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, name, email, role, companyName, companyWebsite, companySize, skills, createdAt FROM users ORDER BY createdAt DESC");
    res.json(rows.map(mapRowToUser));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/my-jobs", requireRole("employer"), async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM jobs WHERE owner_user_id = ? ORDER BY createdAt DESC",
      [req.user.id]
    );
    const jobs = rows.map(mapRowToJob);
    res.json(jobs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/match-jobs", async (req, res) => {
  try {
    const skillsText = typeof req.body?.skills === "string" ? req.body.skills : "";
    const userSkills = parseSkills(skillsText);
    if (!userSkills.length) {
      return res.status(400).json({ error: "No skills provided" });
    }

    const [rows] = await pool.query("SELECT * FROM jobs");
    const jobs = rows.map(mapRowToJob).map(job => {
      const reqSkills = Array.isArray(job.requiredSkills) ? job.requiredSkills : [];
      const lowerUser = new Set(userSkills.map(s => s.toLowerCase()));
      const alreadyHave = reqSkills.filter(s => lowerUser.has(s.toLowerCase()));
      const missingSkills = reqSkills.filter(s => !lowerUser.has(s.toLowerCase()));
      const total = reqSkills.length || 1;
      const matchPercent = Math.round((alreadyHave.length / total) * 100);
      return {
        id: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        workType: job.workType,
        salary: job.salary ? `$${job.salary.toLocaleString?.() || job.salary}` : null,
        seniority: job.seniority,
        summary: job.summary,
        requiredSkills: reqSkills,
        alreadyHave,
        missingSkills,
        matchPercent,
        applyUrl: job.applyUrl,
        createdAt: job.createdAt
      };
    });

    jobs.sort((a, b) => b.matchPercent - a.matchPercent);
    res.json({ jobs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/jobs/:id", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM jobs WHERE id = ? LIMIT 1", [
      req.params.id
    ]);
    if (!rows.length) return res.status(404).json({ error: "Job not found" });
    res.json(mapRowToJob(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/jobs/:id", requireRole("employer"), async (req, res) => {
  try {
    const jobId = req.params.id;
    const [rows] = await pool.query("SELECT * FROM jobs WHERE id = ? LIMIT 1", [jobId]);
    if (!rows.length) return res.status(404).json({ error: "Job not found" });
    const job = rows[0];
    if (job.owner_user_id && job.owner_user_id !== req.user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await pool.query("DELETE FROM jobs WHERE id = ?", [jobId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/jobs", requireRole("employer"), async (req, res) => {
  const {
    title,
    company,
    location,
    workType = null,
    salary = null,
    seniority = null,
    summary = null,
    requiredSkills,
    applyUrl
  } = req.body || {};

  const missing = [];
  if (!title) missing.push("title");
  if (!company) missing.push("company");
  if (!location) missing.push("location");
  if (!applyUrl) missing.push("applyUrl");
  if (!Array.isArray(requiredSkills) || requiredSkills.length === 0) {
    missing.push("requiredSkills");
  }

  if (missing.length) {
    return res
      .status(400)
      .json({ error: "Missing required fields", fields: missing });
  }

  if (salary !== null && (typeof salary !== "number" || salary < 0)) {
    return res
      .status(400)
      .json({ error: "Salary must be a positive number", fields: ["salary"] });
  }

  const job = {
    id: makeId(),
    title: String(title).trim(),
    company: String(company).trim(),
    location: String(location).trim(),
    workType: workType ? String(workType).trim() : null,
    salary,
    seniority: seniority ? String(seniority).trim() : null,
    summary: summary ? String(summary).trim() : null,
    requiredSkills: requiredSkills.map(s => String(s).trim()).filter(Boolean),
    applyUrl: String(applyUrl).trim(),
    createdAt: new Date(),
    owner_user_id: req.user.id
  };

  try {
    await pool.query(
      `INSERT INTO jobs
      (id, title, company, location, workType, salary, seniority, summary, requiredSkills, applyUrl, createdAt, owner_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      , [
        job.id,
        job.title,
        job.company,
        job.location,
        job.workType,
        job.salary,
        job.seniority,
        job.summary,
        job.requiredSkills.join(","),
        job.applyUrl,
        job.createdAt,
        job.owner_user_id
      ]
    );

    res.status(201).json(mapRowToJob({ ...job, requiredSkills: job.requiredSkills.join(",") }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// generic error handler for unhandled rejections
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

function mapRowToJob(row) {
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    location: row.location,
    workType: row.workType,
    salary: row.salary,
    seniority: row.seniority,
    summary: row.summary,
    requiredSkills: typeof row.requiredSkills === "string"
      ? row.requiredSkills.split(",").map(s => s.trim()).filter(Boolean)
      : Array.isArray(row.requiredSkills) ? row.requiredSkills : [],
    applyUrl: row.applyUrl,
    createdAt: row.createdAt,
    owner_user_id: row.owner_user_id
  };
}

function parseSkills(text) {
  return String(text || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function mapRowToUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    companyName: row.companyName,
    companyWebsite: row.companyWebsite,
    companySize: row.companySize,
    skills: row.skills ? row.skills.split(",").map(s => s.trim()).filter(Boolean) : [],
    createdAt: row.createdAt
  };
}

ensureUsersTable()
  .then(() => ensureJobsTable())
  .then(() => ensureAdminUser())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`CareerPath API running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error("Failed to start server", err);
    process.exit(1);
  });
