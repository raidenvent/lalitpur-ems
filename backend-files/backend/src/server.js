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

// Apply the small, idempotent migration required by older Neon databases.
// A Vercel redeploy can therefore upgrade the existing prototype database.
let schemaReady;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(
      `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS x JSONB NOT NULL DEFAULT '{}';
       CREATE OR REPLACE VIEW ems_case_export AS
       SELECT
         c.enc_id, c.created_at, c.updated_at, c.status, c.patient_age,
         c.patient_sex, c.num_patients, c.address, c.landmark,
         c.chief_complaint, c.is_emergency, c.suspected_stroke,
         c.suspected_mi, c.case_type, amb.code AS ambulance,
         c.destination_facility, c.summary_text,
         creator.name AS created_by, closer.name AS closed_by,
         jsonb_build_object(
           'x', COALESCE(a.x, '{}'::jsonb),
           'airway', COALESCE(a.airway, '{}'::jsonb),
           'breathing', COALESCE(a.breathing, '{}'::jsonb),
           'circulation', COALESCE(a.circulation, '{}'::jsonb),
           'disability', COALESCE(a.disability, '{}'::jsonb),
           'exposure', COALESCE(a.exposure, '{}'::jsonb),
           'stroke', COALESCE(a.stroke, '{}'::jsonb),
           'mi', COALESCE(a.mi, '{}'::jsonb),
           'trauma', COALESCE(a.trauma, '{}'::jsonb)
         ) AS clinical_charting,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'time', v.ts, 'recordedBy', vu.name, 'bp', v.bp,
             'pulse', v.pulse, 'rr', v.rr, 'spo2', v.spo2,
             'gcs', v.gcs, 'temp', v.temp
           ) ORDER BY v.ts)
           FROM vitals v LEFT JOIN users vu ON vu.id=v.user_id
           WHERE v.enc_id=c.enc_id
         ), '[]'::jsonb) AS vitals,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'time', m.ts, 'recordedBy', mu.name,
             'medication', m.medication, 'dose', m.dose,
             'route', m.route, 'notes', m.notes
           ) ORDER BY m.ts)
           FROM medications m LEFT JOIN users mu ON mu.id=m.user_id
           WHERE m.enc_id=c.enc_id
         ), '[]'::jsonb) AS medications,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'time', i.ts, 'recordedBy', iu.name,
             'type', i.type, 'notes', i.notes
           ) ORDER BY i.ts)
           FROM interventions i LEFT JOIN users iu ON iu.id=i.user_id
           WHERE i.enc_id=c.enc_id
         ), '[]'::jsonb) AS interventions
       FROM cases c
       LEFT JOIN assessments a ON a.enc_id=c.enc_id
       LEFT JOIN ambulances amb ON amb.id=c.ambulance_id
       LEFT JOIN users creator ON creator.id=c.created_by
       LEFT JOIN users closer ON closer.id=c.summary_closed_by`
    );
  }
  return schemaReady;
}

app.use(helmet());
const allowedOrigins = (process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
}));
app.use(express.json({ limit: "1mb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

app.use("/api", async (req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (error) {
    console.error("[schema] database migration failed", error);
    res.status(503).json({ error: "Database schema is not ready" });
  }
});

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
