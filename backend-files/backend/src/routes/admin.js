const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireRole, hashPassword } = require("../auth");

const router = express.Router();
router.use(requireAuth, requireRole("ADMIN"));

/* --------------------------------- USERS --------------------------------- */
router.get("/users", async (req, res) => {
  const { rows } = await pool.query(`SELECT id, name, phone, role, active, created_at FROM users ORDER BY name`);
  res.json(rows);
});

router.post("/users", async (req, res) => {
  const { name, phone, role, password } = req.body || {};
  if (!name || !phone || !role || !password) return res.status(400).json({ error: "name, phone, role, password required" });
  if (!["ADMIN", "METRO", "PARAMEDIC", "DOCTOR"].includes(role)) return res.status(400).json({ error: "invalid role" });
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (name, phone, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, name, phone, role, active`,
      [name, phone, role, hashPassword(password)]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Phone number already registered" });
    console.error(e);
    res.status(500).json({ error: "Could not create user" });
  }
});

router.patch("/users/:id/active", async (req, res) => {
  const { active } = req.body || {};
  await pool.query(`UPDATE users SET active=$1 WHERE id=$2`, [!!active, req.params.id]);
  res.json({ ok: true });
});

/* ------------------------------ FACILITIES / AMBULANCES -------------------- */
router.get("/facilities", async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM facilities ORDER BY name`);
  res.json(rows);
});
router.post("/facilities", async (req, res) => {
  const { name, isGovernment = true } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "name required" });
  const { rows } = await pool.query(
    `INSERT INTO facilities (name, is_government) VALUES ($1,$2)
     ON CONFLICT (name) DO UPDATE SET active = TRUE RETURNING *`,
    [name, isGovernment]
  );
  res.status(201).json(rows[0]);
});

router.get("/ambulances", async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM ambulances ORDER BY code`);
  res.json(rows);
});
router.post("/ambulances", async (req, res) => {
  const { code } = req.body || {};
  if (!code?.trim()) return res.status(400).json({ error: "code required" });
  const { rows } = await pool.query(
    `INSERT INTO ambulances (code) VALUES ($1) ON CONFLICT (code) DO UPDATE SET active = TRUE RETURNING *`,
    [code]
  );
  res.status(201).json(rows[0]);
});

/* ----------------------------------- REPORTS -------------------------------- */
// GET /api/admin/reports?from=&to=  — aggregate stats + response-time metrics (§23).
router.get("/reports", async (req, res) => {
  const from = req.query.from || "1970-01-01";
  const to = req.query.to || "2999-12-31";

  const totals = await pool.query(
    `SELECT
        count(*) AS total,
        count(*) FILTER (WHERE is_emergency) AS emergency,
        count(*) FILTER (WHERE NOT is_emergency) AS non_emergency,
        count(*) FILTER (WHERE case_type = 'trauma') AS trauma,
        count(*) FILTER (WHERE suspected_stroke) AS stroke,
        count(*) FILTER (WHERE suspected_mi) AS mi,
        count(*) FILTER (WHERE status = 'COMPLETED') AS completed,
        count(*) FILTER (WHERE ambulance_id IS NOT NULL) AS ambulances_dispatched
     FROM cases WHERE created_at BETWEEN $1 AND $2`,
    [from, to]
  );

  // Response-time metrics computed directly from the append-only timeline
  // table — the whole reason timeline events are immutable and normalized.
  const timing = await pool.query(
    `WITH t AS (
       SELECT enc_id,
         MAX(ts) FILTER (WHERE event_type='DISPATCHED') AS dispatched,
         MAX(ts) FILTER (WHERE event_type='ARRIVED_AT_SITE') AS at_scene,
         MAX(ts) FILTER (WHERE event_type='LEFT_SITE') AS left_site,
         MAX(ts) FILTER (WHERE event_type='ARRIVED_HOSPITAL') AS at_hospital,
         MAX(ts) FILTER (WHERE event_type='HANDED_OVER') AS handed_over
       FROM timeline_events GROUP BY enc_id
     )
     SELECT
       AVG(EXTRACT(EPOCH FROM (at_scene - dispatched))) AS avg_dispatch_to_scene_sec,
       AVG(EXTRACT(EPOCH FROM (at_hospital - left_site))) AS avg_scene_to_hospital_sec,
       AVG(EXTRACT(EPOCH FROM (at_hospital - dispatched))) AS avg_total_response_sec,
       AVG(EXTRACT(EPOCH FROM (handed_over - at_hospital))) AS avg_handover_sec
     FROM t`
  );

  const byDestination = await pool.query(
    `SELECT destination_facility AS facility, count(*) AS n
     FROM cases WHERE destination_facility IS NOT NULL AND created_at BETWEEN $1 AND $2
     GROUP BY destination_facility ORDER BY n DESC`,
    [from, to]
  );

  res.json({ totals: totals.rows[0], timing: timing.rows[0], byDestination: byDestination.rows });
});

module.exports = router;
