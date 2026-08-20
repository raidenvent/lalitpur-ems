const express = require("express");
const ExcelJS = require("exceljs");
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

/* ---------------------------- EXCEL DATA EXPORT ---------------------------- */
// Reads the live Neon/PostgreSQL tables and creates a multi-sheet workbook.
// The route is protected by the ADMIN middleware above because it contains
// clinical and operational records.
router.get("/export.xlsx", async (req, res) => {
  const from = req.query.from || "1970-01-01";
  const to = req.query.to || "2999-12-31";
  const range = [from, to];
  const withinRange = `c.created_at >= $1::timestamptz AND c.created_at < ($2::date + interval '1 day')`;

  try {
    const [cases, assessments, vitals, medications, interventions, timeline, handovers, auditRows] = await Promise.all([
      pool.query(
        `SELECT c.enc_id, c.created_at, c.updated_at, c.status, c.patient_age, c.patient_sex,
                c.num_patients, c.address, c.landmark, c.chief_complaint, c.is_emergency,
                c.suspected_stroke, c.suspected_mi, c.description, c.case_type,
                c.ambulance_required, c.ambulance_reason, amb.code AS ambulance,
                c.destination_facility, c.destination_is_alt, c.summary_text,
                c.summary_closed_at, creator.name AS created_by, closer.name AS closed_by
         FROM cases c
         LEFT JOIN ambulances amb ON amb.id=c.ambulance_id
         LEFT JOIN users creator ON creator.id=c.created_by
         LEFT JOIN users closer ON closer.id=c.summary_closed_by
         WHERE ${withinRange} ORDER BY c.created_at`, range),
      pool.query(
        `SELECT a.enc_id, a.updated_at, a.x, a.airway, a.breathing, a.circulation,
                a.disability, a.exposure, a.stroke, a.mi, a.trauma
         FROM assessments a JOIN cases c ON c.enc_id=a.enc_id
         WHERE ${withinRange} ORDER BY a.enc_id`, range),
      pool.query(
        `SELECT v.enc_id, v.ts, u.name AS recorded_by, v.bp, v.pulse, v.rr, v.spo2, v.gcs, v.temp
         FROM vitals v JOIN cases c ON c.enc_id=v.enc_id LEFT JOIN users u ON u.id=v.user_id
         WHERE ${withinRange} ORDER BY v.enc_id, v.ts`, range),
      pool.query(
        `SELECT m.enc_id, m.ts, u.name AS recorded_by, m.medication, m.dose, m.route, m.notes
         FROM medications m JOIN cases c ON c.enc_id=m.enc_id LEFT JOIN users u ON u.id=m.user_id
         WHERE ${withinRange} ORDER BY m.enc_id, m.ts`, range),
      pool.query(
        `SELECT i.enc_id, i.ts, u.name AS recorded_by, i.type, i.notes
         FROM interventions i JOIN cases c ON c.enc_id=i.enc_id LEFT JOIN users u ON u.id=i.user_id
         WHERE ${withinRange} ORDER BY i.enc_id, i.ts`, range),
      pool.query(
        `SELECT t.enc_id, t.ts, u.name AS recorded_by, t.event_type, t.notes
         FROM timeline_events t JOIN cases c ON c.enc_id=t.enc_id LEFT JOIN users u ON u.id=t.user_id
         WHERE ${withinRange} ORDER BY t.enc_id, t.ts`, range),
      pool.query(
        `SELECT h.enc_id, h.arrival_time, h.handover_time, h.facility, h.department,
                h.receiving_person, h.condition_at_handover, h.treatment_provided,
                h.provisional_diagnosis, h.findings, h.notes, h.updated_at
         FROM handover h JOIN cases c ON c.enc_id=h.enc_id
         WHERE ${withinRange} ORDER BY h.enc_id`, range),
      pool.query(
        `SELECT a.enc_id, a.ts, u.name AS "user", a.role, a.action, a.old_value, a.new_value
         FROM audit_log a JOIN cases c ON c.enc_id=a.enc_id LEFT JOIN users u ON u.id=a.user_id
         WHERE ${withinRange} ORDER BY a.enc_id, a.ts`, range),
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Lalitpur Metro EMS";
    workbook.created = new Date();

    const addSheet = (name, rows) => {
      const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
      const normalized = rows.map((row) => Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          value && typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : value,
        ])
      ));
      const keys = [...new Set(normalized.flatMap((row) => Object.keys(row)))];
      sheet.columns = keys.map((key) => ({
        header: key.replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase()),
        key,
        width: Math.min(45, Math.max(14, key.length + 4)),
      }));
      if (normalized.length) sheet.addRows(normalized);
      sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B3D5C" } };
      sheet.getRow(1).alignment = { vertical: "middle" };
      sheet.autoFilter = keys.length ? { from: "A1", to: `${sheet.getColumn(keys.length).letter}1` } : undefined;
      sheet.eachRow((row, rowNumber) => {
        row.alignment = { vertical: "top", wrapText: rowNumber !== 1 };
      });
    };

    addSheet("Cases", cases.rows);
    addSheet("Clinical Charting", assessments.rows);
    addSheet("Vitals", vitals.rows);
    addSheet("Medications", medications.rows);
    addSheet("Interventions", interventions.rows);
    addSheet("Timeline", timeline.rows);
    addSheet("Handovers", handovers.rows);
    addSheet("Audit Log", auditRows.rows);

    const buffer = await workbook.xlsx.writeBuffer();
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="lalitpur-ems-export-${date}.xlsx"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error("[admin export] failed", error);
    res.status(500).json({ error: "Could not create Excel export" });
  }
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
