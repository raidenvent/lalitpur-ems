require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { pool } = require("./db");

const authRoutes = require("./routes/auth");
const caseRoutes = require("./routes/cases");
const adminRoutes = require("./routes/admin");

const app = express();

app.use(helmet());
const allowedOrigins = (process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
}));
app.use(express.json({ limit: "1mb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Basic abuse protection on login (brute-force) — tune for real traffic.
app.use("/api/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
// General API rate limit as a safety net.
app.use("/api", rateLimit({ windowMs: 60 * 1000, max: 300 }));

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected", time: new Date().toISOString() });
  } catch (error) {
    console.error("[health] database check failed", error);
    res.status(503).json({ ok: false, database: "unavailable", time: new Date().toISOString() });
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/cases", caseRoutes);
app.use("/api/admin", adminRoutes);

// Central error handler — never leak stack traces to clients.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 4000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`[lmc-ems] backend listening on :${PORT}`));
}

module.exports = app;
