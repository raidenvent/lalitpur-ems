const { pool } = require("./db");

/** Insert one immutable audit row. Always call inside the same transaction
 *  as the mutation it documents, so audit and data can never drift apart. */
async function audit(client, { encId, userId, role, action, oldValue = null, newValue = null }) {
  await client.query(
    `INSERT INTO audit_log (enc_id, user_id, role, action, old_value, new_value)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [encId, userId, role, action, oldValue, newValue]
  );
}

/** Assemble one case's full record across all tables into the same nested
 *  JSON shape the frontend already works with (see lmc-ems.jsx blankCase()).
 *  This keeps the API contract identical whether the frontend talks to
 *  window.storage (prototype) or this backend (production) — only the
 *  `db.*` functions in the frontend need to change. */
async function getFullCase(encId) {
  const { rows: caseRows } = await pool.query(`SELECT * FROM cases WHERE enc_id = $1`, [encId]);
  if (caseRows.length === 0) return null;
  const c = caseRows[0];

  const [{ rows: timeline }, { rows: vitals }, { rows: assessmentRows },
         { rows: medications }, { rows: interventions }, { rows: handoverRows },
         { rows: consentRows }, { rows: auditRows }] = await Promise.all([
    pool.query(`SELECT event_type AS type, ts, user_id, notes FROM timeline_events WHERE enc_id=$1 ORDER BY ts ASC`, [encId]),
    pool.query(`SELECT ts, user_id, bp, pulse, rr, spo2, gcs, temp FROM vitals WHERE enc_id=$1 ORDER BY ts ASC`, [encId]),
    pool.query(`SELECT * FROM assessments WHERE enc_id=$1`, [encId]),
    pool.query(`SELECT ts, user_id, medication, dose, route, notes FROM medications WHERE enc_id=$1 ORDER BY ts ASC`, [encId]),
    pool.query(`SELECT ts, user_id, type, notes FROM interventions WHERE enc_id=$1 ORDER BY ts ASC`, [encId]),
    pool.query(`SELECT * FROM handover WHERE enc_id=$1`, [encId]),
    pool.query(`SELECT * FROM consent_records WHERE enc_id=$1 ORDER BY ts DESC LIMIT 1`, [encId]),
    pool.query(`SELECT ts, user_id, role, action, old_value, new_value FROM audit_log WHERE enc_id=$1 ORDER BY ts ASC`, [encId]),
  ]);

  const a = assessmentRows[0] || {};
  const h = handoverRows[0] || {};
  const consent = consentRows[0] || null;

  return {
    encId: c.enc_id,
    createdAt: c.created_at,
    createdBy: c.created_by,
    caller: { name: c.caller_name, phone: c.caller_phone },
    patient: { name: c.patient_name, age: c.patient_age, sex: c.patient_sex, numPatients: c.num_patients },
    incident: {
      address: c.address, landmark: c.landmark, chiefComplaint: c.chief_complaint,
      isEmergency: c.is_emergency, suspectedStroke: c.suspected_stroke, suspectedMI: c.suspected_mi,
      description: c.description,
    },
    ambulanceDecision: {
      required: c.ambulance_required, reason: c.ambulance_reason, ambulanceId: c.ambulance_id,
      paramedic: c.paramedic_id, decidedBy: c.decided_by, decidedAt: c.decided_at,
    },
    status: c.status,
    timeline,
    assessment: {
      caseType: c.case_type,
      airway: a.airway || {}, breathing: a.breathing || {}, circulation: a.circulation || {},
      disability: a.disability || {}, exposure: a.exposure || {},
      stroke: a.stroke || {}, mi: a.mi || {}, trauma: a.trauma || {},
    },
    vitals,
    medications,
    interventions,
    destination: { facility: c.destination_facility, isAlternative: c.destination_is_alt, consent },
    handover: {
      facility: h.facility, arrivalTime: h.arrival_time, handoverTime: h.handover_time,
      department: h.department, receivingPerson: h.receiving_person,
      conditionAtHandover: h.condition_at_handover, treatmentProvided: h.treatment_provided,
      provisionalDiagnosis: h.provisional_diagnosis, findings: h.findings, notes: h.notes,
    },
    summary: { text: c.summary_text, closedBy: c.summary_closed_by, closedAt: c.summary_closed_at },
    auditLog: auditRows,
    updatedAt: c.updated_at,
  };
}

/** Lightweight summary row for dashboards/search — avoids assembling the
 *  full nested document for list views. */
async function listCaseSummaries({ q, status, limit = 200 } = {}) {
  const clauses = [];
  const params = [];
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    clauses.push(`(lower(enc_id) LIKE $${params.length} OR lower(patient_name) LIKE $${params.length} OR lower(address) LIKE $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT enc_id AS "encId", patient_name AS "patientName", patient_age AS age, patient_sex AS sex,
            status, created_at AS "createdAt", updated_at AS "updatedAt",
            chief_complaint AS "chiefComplaint", address AS location,
            is_emergency AS "isEmergency", suspected_stroke AS "suspectedStroke",
            suspected_mi AS "suspectedMI", case_type AS "caseType",
            ambulance_id AS "ambulanceId", destination_facility AS destination
     FROM cases ${where}
     ORDER BY updated_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

module.exports = { audit, getFullCase, listCaseSummaries };
