-- =========================================================================
-- Lalitpur Metro Pre-Hospital EMS — PostgreSQL schema
-- =========================================================================
-- Design notes:
--  * EncID is a human-readable business key (LMC-YYYY-NNNNNN) AND the
--    primary key of `cases`. It is generated server-side (see cases.js)
--    from a per-year sequence table with row locking, never client-side,
--    to guarantee uniqueness under concurrent Metro operators.
--  * Nested clinical sub-structures (ABCDE fields, stroke/MI/trauma
--    findings) are stored as JSONB inside `assessments` rather than fully
--    normalized into a dozen near-empty tables. This is a deliberate
--    middle ground: the *events* (timeline, vitals, medications,
--    interventions, audit log) are fully normalized append-only tables
--    because they are queried/aggregated independently (reporting,
--    time-to-scene metrics, audit review). The ABCDE/case-type findings
--    are always read and written as one coherent clinical snapshot per
--    case, so JSONB avoids needless joins with no real query benefit.
--    This can be normalized further later without breaking the API
--    contract — the JSON shape is the API's `assessment` object either way.
--  * Nothing is ever hard-deleted. Corrections go through `audit_log`
--    with old/new values; `cases.status` moves forward, never rolled
--    back destructively.
-- =========================================================================

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT UNIQUE NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('ADMIN','METRO','PARAMEDIC','DOCTOR')),
  password_hash TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS facilities (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  is_government BOOLEAN NOT NULL DEFAULT TRUE,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS ambulances (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

-- One row per year, used to generate sequential EncIDs atomically via
-- `SELECT ... FOR UPDATE`.
CREATE TABLE IF NOT EXISTS enc_id_sequences (
  year   INT PRIMARY KEY,
  next_n INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cases (
  enc_id              TEXT PRIMARY KEY,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          INT REFERENCES users(id),

  caller_name         TEXT,
  caller_phone        TEXT,

  patient_name        TEXT NOT NULL DEFAULT 'Unknown',
  patient_age         TEXT,
  patient_sex         TEXT,
  num_patients        INT NOT NULL DEFAULT 1,

  address             TEXT NOT NULL,
  landmark            TEXT,
  chief_complaint     TEXT NOT NULL,
  is_emergency        BOOLEAN NOT NULL DEFAULT TRUE,
  suspected_stroke    BOOLEAN NOT NULL DEFAULT FALSE,
  suspected_mi        BOOLEAN NOT NULL DEFAULT FALSE,
  description         TEXT,

  ambulance_required  BOOLEAN,
  ambulance_reason    TEXT,
  ambulance_id        INT REFERENCES ambulances(id),
  paramedic_id        INT REFERENCES users(id),
  decided_by          INT REFERENCES users(id),
  decided_at          TIMESTAMPTZ,

  case_type           TEXT NOT NULL DEFAULT 'medical'
                        CHECK (case_type IN ('medical','stroke','mi','trauma','other')),
  status              TEXT NOT NULL DEFAULT 'NEW'
                        CHECK (status IN (
                          'NEW','AMBULANCE_REQUESTED','NO_AMBULANCE','DISPATCHED',
                          'EN_ROUTE','AT_SCENE','ASSESSMENT_IN_PROGRESS','TRANSPORTING',
                          'AT_HOSPITAL','HANDOVER_PENDING','COMPLETED','CANCELLED')),

  destination_facility     TEXT,
  destination_is_alt       BOOLEAN NOT NULL DEFAULT FALSE,

  summary_text        TEXT,
  summary_closed_by   INT REFERENCES users(id),
  summary_closed_at   TIMESTAMPTZ,

  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_created_at ON cases(created_at);
CREATE INDEX IF NOT EXISTS idx_cases_patient_name ON cases USING gin (to_tsvector('simple', patient_name));

-- Append-only dispatch timeline. Never updated/deleted after insert.
CREATE TABLE IF NOT EXISTS timeline_events (
  id         SERIAL PRIMARY KEY,
  enc_id     TEXT NOT NULL REFERENCES cases(enc_id),
  event_type TEXT NOT NULL CHECK (event_type IN (
                'DISPATCHED','LEFT_FOR_SITE','ARRIVED_AT_SITE','PATIENT_ASSESSED',
                'LEFT_SITE','ARRIVED_HOSPITAL','HANDED_OVER')),
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id    INT REFERENCES users(id),
  notes      TEXT,
  UNIQUE (enc_id, event_type)  -- each step recorded exactly once per case
);

CREATE TABLE IF NOT EXISTS vitals (
  id      SERIAL PRIMARY KEY,
  enc_id  TEXT NOT NULL REFERENCES cases(enc_id),
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id INT REFERENCES users(id),
  bp      TEXT,
  pulse   TEXT,
  rr      TEXT,
  spo2    TEXT,
  gcs     TEXT,
  temp    TEXT
);
CREATE INDEX IF NOT EXISTS idx_vitals_enc ON vitals(enc_id, ts);

-- One coherent clinical snapshot per case (see design note above).
CREATE TABLE IF NOT EXISTS assessments (
  enc_id      TEXT PRIMARY KEY REFERENCES cases(enc_id),
  x           JSONB NOT NULL DEFAULT '{}',
  airway      JSONB NOT NULL DEFAULT '{}',
  breathing   JSONB NOT NULL DEFAULT '{}',
  circulation JSONB NOT NULL DEFAULT '{}',
  disability  JSONB NOT NULL DEFAULT '{}',
  exposure    JSONB NOT NULL DEFAULT '{}',
  stroke      JSONB NOT NULL DEFAULT '{}',
  mi          JSONB NOT NULL DEFAULT '{}',
  trauma      JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Safe migration for databases created before the X (catastrophic
-- haemorrhage) assessment was added to the frontend.
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS x JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS medications (
  id         SERIAL PRIMARY KEY,
  enc_id     TEXT NOT NULL REFERENCES cases(enc_id),
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id    INT REFERENCES users(id),
  medication TEXT NOT NULL,
  dose       TEXT,
  route      TEXT,
  notes      TEXT
);

CREATE TABLE IF NOT EXISTS interventions (
  id      SERIAL PRIMARY KEY,
  enc_id  TEXT NOT NULL REFERENCES cases(enc_id),
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id INT REFERENCES users(id),
  type    TEXT NOT NULL,
  notes   TEXT
);

CREATE TABLE IF NOT EXISTS handover (
  enc_id                 TEXT PRIMARY KEY REFERENCES cases(enc_id),
  facility               TEXT,
  arrival_time           TIMESTAMPTZ,
  handover_time          TIMESTAMPTZ,
  department             TEXT,
  receiving_person       TEXT,
  condition_at_handover  TEXT,
  treatment_provided     TEXT,
  provisional_diagnosis  TEXT,
  findings               TEXT,
  notes                  TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per consent event; kept even if the case is later amended,
-- for medico-legal retrievability (§12).
CREATE TABLE IF NOT EXISTS consent_records (
  id                   SERIAL PRIMARY KEY,
  enc_id               TEXT NOT NULL REFERENCES cases(enc_id),
  alternative_facility TEXT NOT NULL,
  reason               TEXT NOT NULL,
  consent_name         TEXT NOT NULL,
  relation             TEXT,
  document_url         TEXT,   -- pointer to stored signed consent doc/image
  signature_url        TEXT,
  ts                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by          INT REFERENCES users(id)
);

-- Immutable audit trail. Application code must INSERT only — never
-- UPDATE/DELETE — enforced additionally by revoking those grants from
-- the application DB role in production (see README "Hardening").
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  enc_id     TEXT NOT NULL REFERENCES cases(enc_id),
  user_id    INT REFERENCES users(id),
  role       TEXT,
  action     TEXT NOT NULL,
  old_value  JSONB,
  new_value  JSONB,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_enc ON audit_log(enc_id, ts);

-- Export-ready read-only view. The clinical event tables remain normalized,
-- but this view lets Neon Console and spreadsheet exports show one row per
-- case with the actual vitals, medications and interventions included.
CREATE OR REPLACE VIEW ems_case_export AS
SELECT
  c.enc_id,
  c.created_at,
  c.updated_at,
  c.status,
  c.patient_age,
  c.patient_sex,
  c.num_patients,
  c.address,
  c.landmark,
  c.chief_complaint,
  c.is_emergency,
  c.suspected_stroke,
  c.suspected_mi,
  c.case_type,
  amb.code AS ambulance,
  c.destination_facility,
  c.summary_text,
  creator.name AS created_by,
  closer.name AS closed_by,
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
      'time', v.ts, 'recordedBy', vu.name, 'bp', v.bp, 'pulse', v.pulse,
      'rr', v.rr, 'spo2', v.spo2, 'gcs', v.gcs, 'temp', v.temp
    ) ORDER BY v.ts)
    FROM vitals v LEFT JOIN users vu ON vu.id=v.user_id
    WHERE v.enc_id=c.enc_id
  ), '[]'::jsonb) AS vitals,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'time', m.ts, 'recordedBy', mu.name, 'medication', m.medication,
      'dose', m.dose, 'route', m.route, 'notes', m.notes
    ) ORDER BY m.ts)
    FROM medications m LEFT JOIN users mu ON mu.id=m.user_id
    WHERE m.enc_id=c.enc_id
  ), '[]'::jsonb) AS medications,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'time', i.ts, 'recordedBy', iu.name, 'type', i.type, 'notes', i.notes
    ) ORDER BY i.ts)
    FROM interventions i LEFT JOIN users iu ON iu.id=i.user_id
    WHERE i.enc_id=c.enc_id
  ), '[]'::jsonb) AS interventions
FROM cases c
LEFT JOIN assessments a ON a.enc_id=c.enc_id
LEFT JOIN ambulances amb ON amb.id=c.ambulance_id
LEFT JOIN users creator ON creator.id=c.created_by
LEFT JOIN users closer ON closer.id=c.summary_closed_by;

-- Seed data (idempotent)
INSERT INTO facilities (name) VALUES
  ('Patan Hospital (Patan Academy of Health Sciences)'),
  ('Civil Service Hospital, Minbhawan'),
  ('Bir Hospital, Kathmandu'),
  ('Tribhuvan University Teaching Hospital (TUTH)'),
  ('Kanti Children''s Hospital'),
  ('Nepal Police Hospital')
ON CONFLICT (name) DO NOTHING;

INSERT INTO ambulances (code) VALUES
  ('LMC Ambulance 1'), ('LMC Ambulance 2'), ('LMC Ambulance 3'), ('Nepal Red Cross Ambulance A')
ON CONFLICT (code) DO NOTHING;
