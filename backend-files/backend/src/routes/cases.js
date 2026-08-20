const express = require("express");
const QRCode = require("qrcode");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { nextEncId } = require("../encId");
const { audit, getFullCase, listCaseSummaries } = require("../caseAssembly");

const router = express.Router();
router.use(requireAuth);

const TIMELINE_TO_STATUS = {
  DISPATCHED: "DISPATCHED",
  LEFT_FOR_SITE: "EN_ROUTE",
  ARRIVED_AT_SITE: "AT_SCENE",
  PATIENT_ASSESSED: "ASSESSMENT_IN_PROGRESS",
  LEFT_SITE: "TRANSPORTING",
  ARRIVED_HOSPITAL: "AT_HOSPITAL",
  HANDED_OVER: "HANDOVER_PENDING",
};

/* ------------------------------- LIST / SEARCH --------------------------- */
// GET /api/cases?q=&status=
router.get("/", async (req, res) => {
  const rows = await listCaseSummaries({ q: req.query.q, status: req.query.status });
  res.json(rows);
});

/* --------------------------------- CREATE --------------------------------- */
// POST /api/cases  — Metro intake (§3). METRO or ADMIN only.
router.post("/", requireRole("METRO", "ADMIN"), async (req, res) => {
  const b = req.body || {};
  if (!b.incident?.address?.trim() || !b.incident?.chiefComplaint?.trim()) {
    return res.status(400).json({ error: "address and chiefComplaint are required" });
  }
  if (b.ambulanceDecision?.required === undefined || b.ambulanceDecision?.required === null) {
    return res.status(400).json({ error: "ambulanceDecision.required must be recorded" });
  }
  if (b.ambulanceDecision.required === false && !b.ambulanceDecision?.reason?.trim()) {
    return res.status(400).json({ error: "reason is required when ambulance is not sent" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const encId = await nextEncId(client);
    const caseType = b.incident.suspectedStroke ? "stroke" : b.incident.suspectedMI ? "mi" : "medical";
    const status = b.ambulanceDecision.required ? "AMBULANCE_REQUESTED" : "NO_AMBULANCE";

    // The UI uses the ambulance code (e.g. "LMC Ambulance 1"),
    // while PostgreSQL stores the numeric ambulances.id foreign key.
    let ambulanceId = null;
    if (b.ambulanceDecision?.ambulanceId) {
      const { rows: ambulanceRows } = await client.query(
        `SELECT id FROM ambulances WHERE code = $1 LIMIT 1`,
        [b.ambulanceDecision.ambulanceId]
      );
      if (!ambulanceRows.length) {
        return res.status(400).json({ error: "Selected ambulance was not found" });
      }
      ambulanceId = ambulanceRows[0].id;
    }

    await client.query(
      `INSERT INTO cases (
         enc_id, created_by, caller_name, caller_phone, patient_name, patient_age, patient_sex,
         num_patients, address, landmark, chief_complaint, is_emergency, suspected_stroke,
         suspected_mi, description, ambulance_required, ambulance_reason, ambulance_id,
         decided_by, decided_at, case_type, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now(), $20,$21)`,
      [
        encId, req.user.id, b.caller?.name, b.caller?.phone,
        b.patient?.name || "Unknown", b.patient?.age, b.patient?.sex, b.patient?.numPatients || 1,
        b.incident.address, b.incident.landmark, b.incident.chiefComplaint, !!b.incident.isEmergency,
        !!b.incident.suspectedStroke, !!b.incident.suspectedMI, b.incident.description,
        b.ambulanceDecision.required, b.ambulanceDecision.reason || null, ambulanceId,
        req.user.id, caseType, status,
      ]
    );
    await client.query(`INSERT INTO assessments (enc_id) VALUES ($1)`, [encId]);
    await client.query(`INSERT INTO handover (enc_id) VALUES ($1)`, [encId]);

    await audit(client, { encId, userId: req.user.id, role: req.user.role, action: "Case created via 1133 intake" });
    await audit(client, {
      encId, userId: req.user.id, role: req.user.role,
      action: b.ambulanceDecision.required
        ? `Ambulance requested${b.ambulanceDecision.ambulanceId ? " — " + b.ambulanceDecision.ambulanceId : ""}`
        : `Ambulance not required — ${b.ambulanceDecision.reason}`,
    });

    await client.query("COMMIT");
    res.status(201).json({ encId });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Could not create case" });
  } finally {
    client.release();
  }
});

/* ---------------------------------- READ ----------------------------------- */
// GET /api/cases/:encId — full nested document (Doctor role gets a filtered view).
router.get("/:encId", async (req, res) => {
  const c = await getFullCase(req.params.encId);
  if (!c) return res.status(404).json({ error: "Case not found" });

  if (req.user.role === "DOCTOR") {
    // Doctors get the clinical/handover picture, not caller PII (§16).
    const { caller, ...rest } = c;
    return res.json({ ...rest, caller: { name: undefined, phone: undefined } });
  }
  res.json(c);
});

/* -------------------------------- TIMELINE ---------------------------------- */
// POST /api/cases/:encId/timeline  { eventType }  — PARAMEDIC only, §5.
router.post("/:encId/timeline", requireRole("PARAMEDIC"), async (req, res) => {
  const { encId } = req.params;
  const { eventType } = req.body || {};
  if (!TIMELINE_TO_STATUS[eventType]) return res.status(400).json({ error: "Invalid event type" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // UNIQUE(enc_id, event_type) makes double-press idempotent-safe:
    // a duplicate press is rejected rather than silently overwriting
    // the original server timestamp (§5 — never overwrite clinical timestamps).
    const ins = await client.query(
      `INSERT INTO timeline_events (enc_id, event_type, user_id)
       VALUES ($1,$2,$3) ON CONFLICT (enc_id, event_type) DO NOTHING
       RETURNING ts`,
      [encId, eventType, req.user.id]
    );
    if (ins.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This step was already recorded and cannot be re-timestamped" });
    }
    await client.query(`UPDATE cases SET status=$1, updated_at=now() WHERE enc_id=$2`, [TIMELINE_TO_STATUS[eventType], encId]);
    await audit(client, {
      encId, userId: req.user.id, role: req.user.role,
      action: `Timeline: ${eventType}`,
      newValue: { eventType, ts: ins.rows[0].ts, status: TIMELINE_TO_STATUS[eventType] },
    });
    await client.query("COMMIT");
    res.json({ ts: ins.rows[0].ts, status: TIMELINE_TO_STATUS[eventType] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Could not record timeline event" });
  } finally {
    client.release();
  }
});

/* -------------------------------- ASSESSMENT --------------------------------- */
// PATCH /api/cases/:encId/assessment  { section, patch, label } — PARAMEDIC only.
router.patch("/:encId/assessment", requireRole("PARAMEDIC"), async (req, res) => {
  const { encId } = req.params;
  const { section, patch, caseType, label } = req.body || {};
  const validSections = ["x", "airway", "breathing", "circulation", "disability", "exposure", "stroke", "mi", "trauma"];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (section) {
      if (!validSections.includes(section)) throw Object.assign(new Error("bad section"), { code: 400 });
      const { rows } = await client.query(`SELECT ${section} FROM assessments WHERE enc_id=$1`, [encId]);
      const oldValue = rows[0]?.[section] || {};
      const newValue = { ...oldValue, ...patch };
      await client.query(`UPDATE assessments SET ${section} = $1, updated_at = now() WHERE enc_id = $2`, [newValue, encId]);
      await audit(client, { encId, userId: req.user.id, role: req.user.role, action: label || `${section} updated`, oldValue, newValue });
    }
    if (caseType) {
      await client.query(`UPDATE cases SET case_type=$1, updated_at=now() WHERE enc_id=$2`, [caseType, encId]);
      await audit(client, { encId, userId: req.user.id, role: req.user.role, action: `Case type set to ${caseType}` });
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(e.code === 400 ? 400 : 500).json({ error: e.code === 400 ? "Invalid section" : "Could not update assessment" });
  } finally {
    client.release();
  }
});

/* ----------------------------------- VITALS ------------------------------------ */
router.post("/:encId/vitals", requireRole("PARAMEDIC"), async (req, res) => {
  const { encId } = req.params;
  const { bp, pulse, rr, spo2, gcs, temp } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO vitals (enc_id, user_id, bp, pulse, rr, spo2, gcs, temp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ts`,
      [encId, req.user.id, bp, pulse, rr, spo2, gcs, temp]
    );
    await audit(client, { encId, userId: req.user.id, role: req.user.role, action: "Vitals recorded", newValue: { bp, pulse, rr, spo2, gcs, temp } });
    await client.query(`UPDATE cases SET updated_at = now() WHERE enc_id = $1`, [encId]);
    await client.query("COMMIT");
    res.status(201).json({ ts: rows[0].ts });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Could not record vitals" });
  } finally { client.release(); }
});

/* ------------------------------- MEDICATIONS / INTERVENTIONS -------------------- */
router.post("/:encId/medications", requireRole("PARAMEDIC"), async (req, res) => {
  const { encId } = req.params;
  const { medication, dose, route, notes } = req.body || {};
  if (!medication?.trim()) return res.status(400).json({ error: "medication is required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO medications (enc_id, user_id, medication, dose, route, notes) VALUES ($1,$2,$3,$4,$5,$6)`,
      [encId, req.user.id, medication, dose, route, notes]
    );
    await audit(client, {
      encId, userId: req.user.id, role: req.user.role,
      action: `Medication given: ${medication}`,
      newValue: { medication, dose, route, notes },
    });
    await client.query(`UPDATE cases SET updated_at = now() WHERE enc_id = $1`, [encId]);
    await client.query("COMMIT");
    res.status(201).json({ ok: true });
  } catch (e) { await client.query("ROLLBACK"); res.status(500).json({ error: "Could not record medication" }); }
  finally { client.release(); }
});

router.post("/:encId/interventions", requireRole("PARAMEDIC"), async (req, res) => {
  const { encId } = req.params;
  const { type, notes } = req.body || {};
  if (!type?.trim()) return res.status(400).json({ error: "type is required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO interventions (enc_id, user_id, type, notes) VALUES ($1,$2,$3,$4)`, [encId, req.user.id, type, notes]);
    await audit(client, {
      encId, userId: req.user.id, role: req.user.role,
      action: `Intervention: ${type}`,
      newValue: { type, notes },
    });
    await client.query(`UPDATE cases SET updated_at = now() WHERE enc_id = $1`, [encId]);
    await client.query("COMMIT");
    res.status(201).json({ ok: true });
  } catch (e) { await client.query("ROLLBACK"); res.status(500).json({ error: "Could not record intervention" }); }
  finally { client.release(); }
});

/* ------------------------------------ DESTINATION -------------------------------- */
// PUT /api/cases/:encId/destination  { facility, isAlternative, consent? }
router.put("/:encId/destination", requireRole("PARAMEDIC"), async (req, res) => {
  const { encId } = req.params;
  const { facility, isAlternative, consent } = req.body || {};
  if (!facility?.trim()) return res.status(400).json({ error: "facility is required" });
  if (isAlternative && (!consent?.reason?.trim() || !consent?.consentName?.trim())) {
    return res.status(400).json({ error: "Alternative destination requires consent.reason and consent.consentName (§12)" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE cases SET destination_facility=$1, destination_is_alt=$2, updated_at=now() WHERE enc_id=$3`,
      [facility, !!isAlternative, encId]
    );
    if (isAlternative) {
      await client.query(
        `INSERT INTO consent_records (enc_id, alternative_facility, reason, consent_name, relation, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [encId, facility, consent.reason, consent.consentName, consent.relation || null, req.user.id]
      );
    }
    await audit(client, {
      encId, userId: req.user.id, role: req.user.role,
      action: isAlternative ? `Alternative destination selected: ${facility} (consent recorded)` : `Destination selected: ${facility}`,
    });
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) { await client.query("ROLLBACK"); console.error(e); res.status(500).json({ error: "Could not set destination" }); }
  finally { client.release(); }
});

/* -------------------------------------- HANDOVER ----------------------------------- */
router.patch("/:encId/handover", requireRole("PARAMEDIC"), async (req, res) => {
  const { encId } = req.params;
  const patch = req.body || {};
  const cols = {
    facility: "facility", department: "department", receivingPerson: "receiving_person",
    conditionAtHandover: "condition_at_handover", treatmentProvided: "treatment_provided",
    provisionalDiagnosis: "provisional_diagnosis", findings: "findings", notes: "notes",
  };
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(cols)) {
    if (patch[k] !== undefined) { params.push(patch[k]); sets.push(`${col} = $${params.length}`); }
  }
  if (patch.markArrival) sets.push(`arrival_time = COALESCE(arrival_time, now())`);
  if (patch.markHandover) sets.push(`handover_time = COALESCE(handover_time, now())`);
  if (sets.length === 0) return res.json({ ok: true });

  params.push(encId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE handover SET ${sets.join(", ")}, updated_at = now() WHERE enc_id = $${params.length}`, params);
    if (patch.markHandover) {
      await client.query(`UPDATE cases SET status='HANDOVER_PENDING', updated_at=now() WHERE enc_id=$1`, [encId]);
    }
    await audit(client, {
      encId, userId: req.user.id, role: req.user.role,
      action: patch.markHandover ? "Patient handed over" : patch.markArrival ? "Hospital arrival recorded" : "Handover details updated",
    });
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) { await client.query("ROLLBACK"); console.error(e); res.status(500).json({ error: "Could not update handover" }); }
  finally { client.release(); }
});

/* ---------------------------------- SUMMARY / CLOSE CASE ---------------------------- */
// PATCH /api/cases/:encId/summary  { summaryText } — optional draft/final summary.
router.patch("/:encId/summary", requireRole("PARAMEDIC"), async (req, res) => {
  const { encId } = req.params;
  const { summaryText = "" } = req.body || {};
  try {
    const { rowCount } = await pool.query(
      `UPDATE cases SET summary_text=$1, updated_at=now() WHERE enc_id=$2`,
      [summaryText, encId]
    );
    if (!rowCount) return res.status(404).json({ error: "Case not found" });
    const client = await pool.connect();
    try {
      await audit(client, { encId, userId: req.user.id, role: req.user.role, action: "Pre-hospital summary saved" });
    } finally { client.release(); }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not save summary" });
  }
});

// POST /api/cases/:encId/close  { summaryText? }
router.post("/:encId/close", requireRole("PARAMEDIC"), async (req, res) => {
  const { encId } = req.params;
  const { summaryText = "" } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT h.handover_time, c.destination_is_alt,
              (SELECT count(*) FROM consent_records WHERE enc_id = c.enc_id) AS consent_count,
              c.status
       FROM cases c LEFT JOIN handover h ON h.enc_id = c.enc_id WHERE c.enc_id = $1`,
      [encId]
    );
    const row = rows[0];
    if (!row) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Case not found" }); }
    if (row.status === "COMPLETED") { await client.query("ROLLBACK"); return res.status(409).json({ error: "Case already closed" }); }
    const blockers = [];
    if (!row.handover_time) blockers.push("Handover time not recorded");
    if (row.destination_is_alt && Number(row.consent_count) === 0) blockers.push("Consent for alternative destination missing");
    if (blockers.length) { await client.query("ROLLBACK"); return res.status(422).json({ error: "Cannot close case", blockers }); }

    await client.query(
      `UPDATE cases SET status='COMPLETED', summary_text=$1, summary_closed_by=$2, summary_closed_at=now(), updated_at=now()
       WHERE enc_id=$3`,
      [summaryText, req.user.id, encId]
    );
    await audit(client, { encId, userId: req.user.id, role: req.user.role, action: "Case closed" });
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) { await client.query("ROLLBACK"); console.error(e); res.status(500).json({ error: "Could not close case" }); }
  finally { client.release(); }
});

/* -------------------------------------- QR ------------------------------------------- */
// GET /api/cases/:encId/qr — real QR PNG (base64) pointing at the secure doctor-view URL.
// The QR encodes ONLY the pointer URL, never patient data (§15).
router.get("/:encId/qr", async (req, res) => {
  const base = (process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  const url = `${base}/doctor/case/${encodeURIComponent(req.params.encId)}`;
  const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
  res.json({ url, qr: dataUrl });
});

module.exports = router;
