import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Ambulance, Phone, MapPin, User, Users, Clock, AlertTriangle, CheckCircle2,
  Circle, ChevronRight, ChevronLeft, Search, Plus, LogOut, ShieldCheck,
  Activity, Heart, Brain, Bone, Stethoscope, FileText, QrCode, Wifi, WifiOff,
  RefreshCw, Lock, ClipboardList, Building2, ClipboardCheck, AlertOctagon,
  Pill, Syringe, Droplet, Save, X, ArrowRight, BadgeCheck, History
} from "lucide-react";
import "./App.css";

/* =========================================================================
   LALITPUR METROPOLITAN CITY — PRE-HOSPITAL EMERGENCY CARE MANAGEMENT SYSTEM
   =========================================================================

   ARCHITECTURE NOTES (read before editing)
   -----------------------------------------------------------------------
   This artifact is a functional PROTOTYPE of the full system described in
   the brief. It demonstrates the complete data model, workflow, role
   separation, and UI, running against the artifact `window.storage` KV
   API standing in for a real backend database.

   Key irreversible-ish decisions made, and why:

   1. AGGREGATE-DOCUMENT MODEL, NOT STRICT RELATIONAL TABLES.
      Every EncID owns exactly one JSON document (`case:<EncID>`) that
      nests its timeline, assessment, vitals, medications, interventions,
      handover and consent data, plus an embedded per-case audit log.
      Rationale: the case is always read/written as a whole by a single
      paramedic in the field with poor connectivity — one document means
      one GET and one PUT per save, which matters a lot when the network
      is bad. In a real deployment this document model maps directly onto
      a document DB (MongoDB/DynamoDB/Postgres+JSONB); the "DATA MODEL"
      section below still documents the logical relational shape so a
      relational backend (Postgres with real tables + FKs) is equally
      valid — this prototype's storage layer (`db.*` functions) is the
      seam where a real backend would replace `window.storage` calls with
      real HTTP calls, without changing any UI code.

   2. SHARED (not per-user) STORAGE.
      All clinical/dispatch data uses `shared: true` so Metro, Paramedic,
      Doctor and Admin roles all see the same live case data — this is
      required for the system to function as a shared operational tool.
      NOTE: because this prototype's "login" is a role-picker (see #4),
      shared storage is what lets you open two browser tabs, log in as
      Metro in one and Paramedic in the other, and see the same case.

   3. NO REAL AUTHENTICATION IN THIS PROTOTYPE.
      Real deployment needs government SSO / credentialed login with
      server-verified roles (see §16 of the brief). Here, login is a
      role + name picker. This is called out on the login screen itself
      and must be replaced before any real deployment. Every write is
      still tagged with the "logged in" name+role so the audit trail
      mechanics are demonstrated faithfully.

   4. QR CODE.
      The QR must point to a secure URL, never carry PHI. This prototype
      renders a deterministic placeholder QR pattern (visually a QR code,
      not a scannable one — no QR-encoding library is available in this
      sandbox) and shows the actual secure pointer URL in text underneath.
      In production, generate a real QR (e.g. `qrcode` npm package) server
      side for a signed, short-lived, per-EncID doctor-view URL.

   5. OFFLINE / SYNC HANDLING.
      Every mutation goes through `saveCase()`, which: (a) optimistically
      updates local state so the UI never appears to "lose" work, (b)
      attempts the network write, (c) on failure, queues the change in an
      in-memory "pending sync" list and shows a persistent banner with a
      Retry button, (d) never marks a card as "Saved" until the server
      write actually succeeds. True offline-first (service worker + local
      IndexedDB queue that survives a tab close) is flagged as a
      follow-up — this prototype demonstrates the online-first fallback
      with graceful degradation described as acceptable in §20.

   6. TIMESTAMPS are always server-clock (Date.now() at the moment the
      storage write is confirmed), never client-typed, per §5.
   ------------------------------------------------------------------------- */

/* ---------------------------- CONSTANTS -------------------------------- */

const ROLES = {
  ADMIN: "Admin",
  METRO: "Metro Operator",
  PARAMEDIC: "HCW( Doctor/Paramedic)",
  DOCTOR: "Receiving Facility",
};

const STATUS = {
  NEW: "NEW",
  AMBULANCE_REQUESTED: "AMBULANCE_REQUESTED",
  NO_AMBULANCE: "NO_AMBULANCE",
  DISPATCHED: "DISPATCHED",
  EN_ROUTE: "EN_ROUTE",
  AT_SCENE: "AT_SCENE",
  ASSESSMENT_IN_PROGRESS: "ASSESSMENT_IN_PROGRESS",
  TRANSPORTING: "TRANSPORTING",
  AT_HOSPITAL: "AT_HOSPITAL",
  HANDOVER_PENDING: "HANDOVER_PENDING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
};

const STATUS_LABEL = {
  NEW: "New",
  AMBULANCE_REQUESTED: "Ambulance Requested",
  NO_AMBULANCE: "No Ambulance Sent",
  DISPATCHED: "Dispatched",
  EN_ROUTE: "En Route",
  AT_SCENE: "At Scene",
  ASSESSMENT_IN_PROGRESS: "Assessment In Progress",
  TRANSPORTING: "Transporting",
  AT_HOSPITAL: "At Hospital",
  HANDOVER_PENDING: "Handover Pending",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

const STATUS_COLOR = {
  NEW: "bg-slate-200 text-slate-800",
  AMBULANCE_REQUESTED: "bg-amber-100 text-amber-800",
  NO_AMBULANCE: "bg-slate-200 text-slate-600",
  DISPATCHED: "bg-blue-100 text-blue-800",
  EN_ROUTE: "bg-blue-100 text-blue-800",
  AT_SCENE: "bg-indigo-100 text-indigo-800",
  ASSESSMENT_IN_PROGRESS: "bg-indigo-100 text-indigo-800",
  TRANSPORTING: "bg-violet-100 text-violet-800",
  AT_HOSPITAL: "bg-teal-100 text-teal-800",
  HANDOVER_PENDING: "bg-amber-100 text-amber-800",
  COMPLETED: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-rose-100 text-rose-800",
};

const TIMELINE_STEPS = [
  { key: "DISPATCHED", label: "Accepted / Dispatched", status: STATUS.DISPATCHED },
  { key: "LEFT_FOR_SITE", label: "Left for Site", status: STATUS.EN_ROUTE },
  { key: "ARRIVED_AT_SITE", label: "Arrived at Site", status: STATUS.AT_SCENE },
  { key: "PATIENT_ASSESSED", label: "Patient Assessed", status: STATUS.ASSESSMENT_IN_PROGRESS },
  { key: "LEFT_SITE", label: "Left Site / Transporting", status: STATUS.TRANSPORTING },
  { key: "ARRIVED_HOSPITAL", label: "Arrived at Hospital", status: STATUS.AT_HOSPITAL },
  { key: "HANDED_OVER", label: "Patient Handed Over", status: STATUS.HANDOVER_PENDING },
];

const FACILITIES = [
  "Patan Hospital (Patan Academy of Health Sciences)",
  "Civil Service Hospital, Minbhawan",
  "Bir Hospital, Kathmandu",
  "Tribhuvan University Teaching Hospital (TUTH)",
  "Kanti Children's Hospital",
  "Nepal Police Hospital",
];

const AMBULANCES = ["LMC Ambulance 1", "LMC Ambulance 2", "LMC Ambulance 3", "Nepal Red Cross Ambulance A"];

const CASE_TYPES = [
  { key: "medical", label: "General Medical" },
  { key: "stroke", label: "Suspected Stroke" },
  { key: "mi", label: "Suspected MI (Cardiac)" },
  { key: "trauma", label: "Trauma" },
  { key: "other", label: "Other" },
];

const INJURY_LOCATIONS = ["Head", "Face", "Neck", "Chest", "Abdomen", "Pelvis", "Upper Limb", "Lower Limb", "Spine", "Multiple Sites"];
const MECHANISMS = ["Road Traffic Accident", "Fall", "Assault", "Burn", "Penetrating Injury", "Other"];
const INTERVENTION_TYPES = ["Oxygen", "IV Fluid", "CPR", "AED", "Immobilization", "Splinting", "Wound Management", "Other"];

/* --------------------------- STORAGE LAYER ------------------------------
   Thin wrapper around window.storage. This is the ONLY place that talks
   to persistence — swap these five functions for real HTTP calls to
   migrate to a production backend without touching UI code. */

const API_BASE = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");

function authHeaders(token, json = false) {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function apiRequest(path, { token, ...options } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...authHeaders(token, !!options.body), ...(options.headers || {}) },
  });
  let data = null;
  try { data = await response.json(); } catch { /* empty response */ }
  if (!response.ok) {
    const message = data?.error || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

/* Backend API persistence. Authentication is always sent as a JWT. */
const db = {
  async getCase(encId, token) {
    try { return await apiRequest(`/cases/${encodeURIComponent(encId)}`, { token }); }
    catch { return null; }
  },
  async getIndex(token) {
    try { return await apiRequest("/cases", { token }) || []; }
    catch { return []; }
  },
  async createCase(payload, token) {
    return apiRequest("/cases", {
      token,
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
};

/* ------------------------------ HELPERS --------------------------------- */

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function fmtTimeShort(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function makeEncId(seq) {
  const year = new Date().getFullYear();
  return `LMC-${year}-${String(seq).padStart(6, "0")}`;
}

function blankCase(encId, user) {
  return {
    encId,
    createdAt: Date.now(),
    createdBy: user,
    caller: { name: "", phone: "" },
    patient: { name: "", age: "", sex: "", numPatients: 1 },
    incident: {
      address: "", landmark: "", chiefComplaint: "",
      isEmergency: true, suspectedStroke: false, suspectedMI: false,
      description: "",
    },
    ambulanceDecision: { required: null, reason: "", ambulanceId: "", paramedic: "", decidedBy: "", decidedAt: null },
    status: STATUS.NEW,
    timeline: [],
    assessment: {
      caseType: "medical",
      x: {bleeding: "No catastrophic bleeding", intervention: "", bleedingControlled: "", site: "", tourniquetTime: "", remarks: "",},
      airway: { status: "", intervention: "", notes: "" },
      breathing: { rr: "", spo2: "", distress: "", o2: "", intervention: "", notes: "" },
      circulation: { pulse: "", bp: "", capRefill: "", bleeding: "", ivAccess: "", intervention: "", notes: "" },
      disability: { gcs: "", glucose: "", pupils: "", seizure: "", neuro: "", notes: "" },
      exposure: { temp: "", findings: "", injuries: "", notes: "" },
      stroke: { lastKnownWell: "", balance: "", eyes: "", face: "", arm: "", speech: "" },
      mi: { onsetTime: "", symptoms: "", cardiacHistory: "" },
      trauma: { mechanism: "", injuryLocations: [], findings: "", notes: "" },
    },
    vitals: [],
    medications: [],
    interventions: [],
    destination: { facility: "", isAlternative: false, consent: null },
    handover: {
      facility: "", arrivalTime: null, handoverTime: null, department: "",
      receivingPerson: "", conditionAtHandover: "", treatmentProvided: "",
      provisionalDiagnosis: "", findings: "", notes: "",
    },
    summary: { text: "", closedBy: "", closedAt: null },
    auditLog: [],
  };
}

function summarize(c) {
  return {
    encId: c.encId,
    age: c.patient?.age || "",
    sex: c.patient?.sex || "",
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: Date.now(),
    chiefComplaint: c.incident?.chiefComplaint || "",
    location: c.incident?.address || "",
    isEmergency: !!c.incident?.isEmergency,
    suspectedStroke: !!c.incident?.suspectedStroke,
    suspectedMI: !!c.incident?.suspectedMI,
    caseType: c.assessment?.caseType || "medical",
    ambulanceId: c.ambulanceDecision?.ambulanceId || "",
    destination: c.destination?.facility || "",
  };
}

/* =========================================================================
   ROOT APP
   ========================================================================= */

export default function App() {
  const [session, setSession] = useState(() => {
    try {
      const saved = localStorage.getItem("lmc-ems-session");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  }); // { id, role, name, token }
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [pending, setPending] = useState([]); // queued failed writes: {label, retry}
  const [view, setView] = useState("dashboard");
  const [activeEncId, setActiveEncId] = useState(null);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // If a QR/secure link opens /case/:encId, remember that case and open it
  // after the user authenticates. This makes QR links work on localhost too.
  useEffect(() => {
    const match = window.location.pathname.match(/^\/(?:doctor\/)?case\/([^/]+)\/?$/i);
    if (match && session) {
      const id = decodeURIComponent(match[1]).toUpperCase();
      setActiveEncId(id);
      setView("case");
    }
  }, [session]);

  const queuePending = useCallback((label, retryFn) => {
    setPending((p) => [...p, { id: Math.random().toString(36).slice(2), label, retryFn }]);
  }, []);
  const clearPending = useCallback((id) => {
    setPending((p) => p.filter((x) => x.id !== id));
  }, []);

  if (!session) {
    return <LoginScreen onLogin={(nextSession) => {
      localStorage.setItem("lmc-ems-session", JSON.stringify(nextSession));
      setSession(nextSession);
    }} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <SyncBanner online={online} pending={pending} onRetry={async (item) => {
        try { await item.retryFn(); clearPending(item.id); } catch { /* stays queued */ }
      }} />
      <TopBar
        session={session}
        online={online}
        onLogout={() => {
          localStorage.removeItem("lmc-ems-session");
          setSession(null);
          setView("dashboard");
          setActiveEncId(null);
        }}
        onHome={() => setView("dashboard")}
        onOpenCase={(id) => { setActiveEncId(id); setView("case"); }}
      />
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 py-5">
        {view === "dashboard" && (
          <RoleDashboard
            session={session}
            onNewCase={() => setView("new-case")}
            onOpenCase={(id) => { setActiveEncId(id); setView("case"); }}
            onAdmin={() => setView("admin")}
            queuePending={queuePending}
          />
        )}
        {view === "new-case" && (
          <NewCaseForm
            session={session}
            onDone={(id) => { setActiveEncId(id); setView("case"); }}
            onCancel={() => setView("dashboard")}
            queuePending={queuePending}
          />
        )}
        {view === "case" && activeEncId && (
          <CaseWorkspace
            encId={activeEncId}
            session={session}
            onClose={() => setView("dashboard")}
            queuePending={queuePending}
          />
        )}
        {view === "admin" && <AdminPanel session={session} onOpenCase={(id) => { setActiveEncId(id); setView("case"); }} />}
      </main>
      <footer className="text-center text-xs text-slate-400 py-3">
        Lalitpur Metropolitan City — Pre-Hospital Emergency Care Management System · Prototype build
      </footer>
    </div>
  );
}

/* -------------------------------- LOGIN --------------------------------- */

function LoginScreen({ onLogin }) {
  const [role, setRole] = useState(null);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loginRoles = [
    {
      key: "METRO",
      label: "Metro Operator",
      description: "1131 intake & ambulance dispatch",
      icon: Building2,
    },
    {
      key: "PARAMEDIC",
      label: "HCW (Doctor/Paramedic)",
      description: "Field response & patient care",
      icon: Ambulance,
    },
    {
      key: "DOCTOR",
      label: "Receiving Facility",
      description: "Clinical review & handover",
      icon: Stethoscope,
    },
    {
      key: "ADMIN",
      label: "System Administrator",
      description: "Users, cases, facilities & reports",
      icon: ShieldCheck,
    },
  ];

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!role) {
      setError("Please select your role.");
      return;
    }
    if (!phone.trim() || !password) {
      setError("Enter your phone number and password.");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: phone.trim(),
          password,
        }),
      });

      let data = {};
      try {
        data = await response.json();
      } catch {
        // Keep the generic error below if the server did not return JSON.
      }

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error("EMS API route was not found. Redeploy the Vercel backend function.");
        }
        if (response.status >= 500) {
          throw new Error(`EMS backend is unavailable (HTTP ${response.status}). Check the Vercel Function logs and environment variables.`);
        }
        throw new Error(data.error || "Invalid phone number or password.");
      }

      // The server is the source of truth for the user's role.
      // Do not trust a role selected in the browser.
      if (data.user?.role !== role) {
        throw new Error(`These credentials belong to the ${ROLES[data.user?.role] || "other"} account. Select the correct role.`);
      }

      onLogin({
        id: data.user.id,
        name: data.user.name,
        role: data.user.role,
        token: data.token,
      });
    } catch (err) {
      setError(
        err?.message?.includes("Failed to fetch")
          ? `Cannot reach the EMS API at ${API_BASE}. Check the deployment URL, CORS settings, and Vercel Function status.`
          : err?.message || "Login failed."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ems-login-page">
      <div className="ems-login-shell">
        <div className="ems-login-brand">
          <div className="ems-login-logo">
            <Ambulance size={27} />
          </div>
          <div>
            <div className="ems-login-title">Lalitpur Metro EMS</div>
            <div className="ems-login-subtitle">Pre-Hospital Emergency Care Management System</div>
          </div>
        </div>

        <div className="ems-login-card">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-slate-900">Sign in</h1>
            <p className="text-sm text-slate-500 mt-1">
              Use your registered phone number and password.
            </p>
          </div>

          <form onSubmit={handleSubmit}>
            <div>
              <label className="ems-login-label">Select your role</label>
              <div className="grid gap-2 mt-2">
                {loginRoles.map(({ key, label, description, icon: Icon }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setRole(key);
                      setError("");
                    }}
                    className={`ems-role-card ${role === key ? "ems-role-card-active" : ""}`}
                  >
                    <span className={`ems-role-icon ${role === key ? "ems-role-icon-active" : ""}`}>
                      <Icon size={20} />
                    </span>
                    <span className="text-left flex-1">
                      <span className="block font-semibold text-sm">{label}</span>
                      <span className="block text-xs text-slate-500 mt-0.5">{description}</span>
                    </span>
                    {role === key && <CheckCircle2 size={19} className="text-[#0B3D5C]" />}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-5">
              <label htmlFor="login-phone" className="ems-login-label">Phone number</label>
              <input
                id="login-phone"
                type="tel"
                inputMode="numeric"
                autoComplete="username"
                className="ems-login-input mt-2"
                placeholder="e.g. 9800000003"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  setError("");
                }}
                disabled={loading}
              />
            </div>

            <div className="mt-4">
              <label htmlFor="login-password" className="ems-login-label">Password</label>
              <div className="relative mt-2">
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  className="ems-login-input pr-12"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError("");
                  }}
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 text-xs font-medium"
                  tabIndex={-1}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            {error && (
              <div className="ems-login-error mt-4" role="alert">
                <AlertTriangle size={17} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !role || !phone.trim() || !password}
              className="ems-login-submit mt-5"
            >
              {loading ? (
                <>
                  <RefreshCw size={17} className="animate-spin" />
                  Verifying credentials...
                </>
              ) : (
                <>
                  <Lock size={17} />
                  Sign in securely
                </>
              )}
            </button>
          </form>

          <div className="ems-login-security">
            <ShieldCheck size={16} />
            <span>Credentials are verified by the EMS server. Your selected role is checked against the account.</span>
          </div>
        </div>

        <p className="ems-login-footer">
          Lalitpur Metropolitan City · Emergency Medical Services
        </p>
      </div>
    </div>
  );
}

/* -------------------------------- TOP BAR -------------------------------- */

function TopBar({ session, online, onLogout, onHome, onOpenCase }) {
  const [token, setToken] = useState("");
  return (
    <div className="bg-[#0B3D5C] text-white">
      <div className="max-w-7xl mx-auto px-4 py-2.5 flex flex-wrap items-center gap-3">
        <button onClick={onHome} className="flex items-center gap-2 font-bold">
          <Ambulance size={20} /> LMC EMS
        </button>
        <span className={`text-xs px-2 py-1 rounded-full flex items-center gap-1 ${online ? "bg-emerald-500/20 text-emerald-200" : "bg-rose-500/30 text-rose-100"}`}>
          {online ? <Wifi size={12} /> : <WifiOff size={12} />} {online ? "Online" : "Offline"}
        </span>
        <div className="flex-1" />
        <form
          onSubmit={(e) => { e.preventDefault(); if (token.trim()) { onOpenCase(token.trim().toUpperCase()); setToken(""); } }}
          className="flex items-center gap-1 bg-white/10 rounded-lg px-2 py-1"
        >
          <Search size={14} />
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Enter EncID / Token"
            className="bg-transparent text-sm placeholder-white/60 outline-none w-40"
          />
        </form>
        <div className="text-right text-xs">
          <div className="font-semibold">{session.name}</div>
          <div className="text-white/70">{ROLES[session.role]}</div>
        </div>
        <button onClick={onLogout} className="p-2 rounded-lg hover:bg-white/10"><LogOut size={16} /></button>
      </div>
    </div>
  );
}

function SyncBanner({ online, pending, onRetry }) {
  if (online && pending.length === 0) return null;
  return (
    <div className="bg-amber-500 text-amber-950 text-sm px-4 py-2 flex items-center gap-3 flex-wrap">
      <AlertTriangle size={16} />
      {!online && <span>No connection — changes will not save until you're back online.</span>}
      {pending.map((p) => (
        <span key={p.id} className="flex items-center gap-2 bg-amber-600/20 px-2 py-1 rounded-full">
          Not synced: {p.label}
          <button onClick={() => onRetry(p)} className="flex items-center gap-1 font-semibold underline">
            <RefreshCw size={12} /> Retry
          </button>
        </span>
      ))}
    </div>
  );
}

/* =========================================================================
   ROLE DASHBOARD ROUTER
   ========================================================================= */

function RoleDashboard({ session, onNewCase, onOpenCase, onAdmin, queuePending }) {
  const [cases, setCases] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const idx = await db.getIndex(session.token);
    setCases(idx.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)));
    setLoading(false);
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  if (session.role === "METRO") return <MetroDashboard cases={cases} loading={loading} onNewCase={onNewCase} onOpenCase={onOpenCase} onRefresh={load} />;
  if (session.role === "PARAMEDIC") return <ParamedicDashboard cases={cases} loading={loading} onOpenCase={onOpenCase} onRefresh={load} />;
  if (session.role === "DOCTOR") return <DoctorSearch cases={cases} onOpenCase={onOpenCase} />;
  if (session.role === "ADMIN") return <AdminHome cases={cases} onAdmin={onAdmin} onOpenCase={onOpenCase} />;
  return null;
}

/* ------------------------------ METRO VIEW ------------------------------- */

function StatCard({ label, value, tone = "slate", icon: Icon }) {
  const tones = {
    slate: "bg-white border-slate-200 text-slate-900",
    blue: "bg-blue-50 border-blue-200 text-blue-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-900",
    rose: "bg-rose-50 border-rose-200 text-rose-900",
  };
  return (
    <div className={`rounded-xl border p-4 ${tones[tone]}`}>
      <div className="flex items-center justify-between">
        <div className="text-2xl font-bold">{value}</div>
        {Icon && <Icon size={18} className="opacity-60" />}
      </div>
      <div className="text-xs mt-1 opacity-80">{label}</div>
    </div>
  );
}

function MetroDashboard({ cases, loading, onNewCase, onOpenCase, onRefresh }) {
  const [q, setQ] = useState("");
  const today = new Date().toDateString();
  const todayCases = cases.filter((c) => new Date(c.createdAt).toDateString() === today);
  const active = cases.filter((c) => ![STATUS.COMPLETED, STATUS.CANCELLED, STATUS.NO_AMBULANCE].includes(c.status));

  const filtered = cases.filter((c) => {
    const s = q.toLowerCase();
    if (!s) return true;
    return c.encId.toLowerCase().includes(s) || c.location.toLowerCase().includes(s);
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold">Metro Call-Centre Dashboard</h1>
        <button onClick={onNewCase} className="bg-[#0B3D5C] text-white font-semibold px-5 py-3 rounded-lg flex items-center gap-2">
          <Phone size={18} /> New Emergency Call (1131)
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="New calls today" value={todayCases.length} icon={Phone} tone="blue" />
        <StatCard label="Active cases" value={active.length} icon={Activity} tone="amber" />
        <StatCard label="Dispatched / En route" value={cases.filter((c) => [STATUS.DISPATCHED, STATUS.EN_ROUTE].includes(c.status)).length} icon={Ambulance} />
        <StatCard label="At scene" value={cases.filter((c) => c.status === STATUS.AT_SCENE).length} />
        <StatCard label="Transporting" value={cases.filter((c) => c.status === STATUS.TRANSPORTING).length} />
        <StatCard label="Awaiting handover" value={cases.filter((c) => c.status === STATUS.HANDOVER_PENDING).length} tone="amber" />
        <StatCard label="Completed" value={cases.filter((c) => c.status === STATUS.COMPLETED).length} tone="emerald" />
        <StatCard label="No ambulance sent" value={cases.filter((c) => c.status === STATUS.NO_AMBULANCE).length} tone="rose" />
      </div>

      <div className="bg-white rounded-xl border border-slate-200">
        <div className="p-3 border-b border-slate-100 flex items-center gap-2">
          <Search size={16} className="text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by EncID, location..." className="flex-1 outline-none text-sm" />
          <button onClick={onRefresh} className="text-slate-400 hover:text-slate-700"><RefreshCw size={15} /></button>
        </div>
        <CaseTable cases={filtered} loading={loading} onOpenCase={onOpenCase} />
      </div>
    </div>
  );
}

function CaseTable({ cases, loading, onOpenCase }) {
  if (loading) return <div className="p-6 text-sm text-slate-400">Loading cases…</div>;
  if (cases.length === 0) return <div className="p-6 text-sm text-slate-400">No cases yet.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-100">
            <th className="p-3">EncID</th>
            <th className="p-3">Chief Complaint</th>
            <th className="p-3">Location</th>
            <th className="p-3">Status</th>
            <th className="p-3">Updated</th>
            <th className="p-3"></th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.encId} className="border-b border-slate-50 hover:bg-slate-50">
              <td className="p-3 font-mono text-xs">{c.encId}</td>
              <td className="p-3">{c.chiefComplaint || "—"}</td>
              <td className="p-3">{c.location || "—"}</td>
              <td className="p-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLOR[c.status]}`}>{STATUS_LABEL[c.status]}</span></td>
              <td className="p-3 text-xs text-slate-500">{fmtTime(c.updatedAt)}</td>
              <td className="p-3"><button onClick={() => onOpenCase(c.encId)} className="text-[#0B3D5C] font-semibold text-xs flex items-center gap-1">Open <ChevronRight size={14} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------- PARAMEDIC VIEW ------------------------------ */

function ParamedicDashboard({ cases, loading, onOpenCase, onRefresh }) {
  const [token, setToken] = useState("");
  const active = cases.filter((c) => ![STATUS.COMPLETED, STATUS.CANCELLED, STATUS.NO_AMBULANCE, STATUS.NEW].includes(c.status));
  const awaiting = cases.filter((c) => c.status === STATUS.AMBULANCE_REQUESTED);
  const completed = cases.filter((c) => c.status === STATUS.COMPLETED).slice(0, 20);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold">Ambulance / Paramedic Dashboard</h1>
        <form
          onSubmit={(e) => { e.preventDefault(); if (token.trim()) onOpenCase(token.trim().toUpperCase()); }}
          className="flex items-center gap-2"
        >
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="ENTER TOKEN MANUALLY (EncID)"
            className="border-2 border-slate-300 rounded-lg px-4 py-3 text-base font-mono w-64 focus:border-[#0B3D5C] outline-none" />
          <button type="submit" className="bg-[#0B3D5C] text-white font-semibold px-5 py-3 rounded-lg">Go</button>
        </form>
      </div>

      <section>
        <h2 className="font-semibold text-slate-700 mb-2 flex items-center gap-2"><Activity size={16} /> Active Cases</h2>
        {loading ? <div className="text-sm text-slate-400">Loading…</div> : active.length === 0 ? (
          <div className="text-sm text-slate-400 bg-white border border-dashed border-slate-200 rounded-xl p-6 text-center">No active cases assigned right now.</div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {active.map((c) => <ParamedicCaseCard key={c.encId} c={c} onOpen={() => onOpenCase(c.encId)} urgent />)}
          </div>
        )}
      </section>

      {awaiting.length > 0 && (
        <section>
          <h2 className="font-semibold text-slate-700 mb-2 flex items-center gap-2"><AlertOctagon size={16} className="text-amber-600" /> Awaiting Dispatch Acceptance</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {awaiting.map((c) => <ParamedicCaseCard key={c.encId} c={c} onOpen={() => onOpenCase(c.encId)} urgent />)}
          </div>
        </section>
      )}

      <section>
        <h2 className="font-semibold text-slate-700 mb-2 flex items-center gap-2"><CheckCircle2 size={16} className="text-emerald-600" /> Completed Cases</h2>
        {completed.length === 0 ? <div className="text-sm text-slate-400">None yet.</div> : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {completed.map((c) => <ParamedicCaseCard key={c.encId} c={c} onOpen={() => onOpenCase(c.encId)} />)}
          </div>
        )}
      </section>
    </div>
  );
}

function ParamedicCaseCard({ c, onOpen, urgent }) {
  return (
    <button onClick={onOpen} className={`text-left bg-white rounded-xl border-2 p-4 hover:shadow-md transition ${urgent ? "border-[#0B3D5C]/30" : "border-slate-200"}`}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-slate-500">{c.encId}</span>
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_COLOR[c.status]}`}>{STATUS_LABEL[c.status]}</span>
      </div>
      <div className="text-xs text-slate-500 truncate mt-2">{c.chiefComplaint || "No complaint recorded"}</div>
      <div className="flex items-center gap-3 mt-2 text-xs text-slate-400">
        <span className="flex items-center gap-1"><Clock size={12} /> {fmtTime(c.updatedAt)}</span>
        {c.suspectedStroke && <span className="text-rose-600 font-semibold">STROKE</span>}
        {c.suspectedMI && <span className="text-rose-600 font-semibold">MI</span>}
      </div>
      <div className="mt-3 bg-[#0B3D5C] text-white text-center text-sm font-semibold rounded-lg py-2">CONTINUE CASE</div>
    </button>
  );
}

/* ----------------------------- DOCTOR VIEW LIST --------------------------- */

function DoctorSearch({ cases, onOpenCase }) {
  const [token, setToken] = useState("");
  const recent = cases.filter((c) => [STATUS.AT_HOSPITAL, STATUS.HANDOVER_PENDING, STATUS.COMPLETED].includes(c.status)).slice(0, 12);
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold">Receiving Facility — Scan / Lookup</h1>
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <p className="text-sm text-slate-500 mb-3">Scan the patient's EncID QR code, or enter the EncID / secure link token manually.</p>
        <form onSubmit={(e) => { e.preventDefault(); if (token.trim()) onOpenCase(token.trim().toUpperCase()); }} className="flex gap-2">
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="LMC-2026-000184"
            className="flex-1 border-2 border-slate-300 rounded-lg px-4 py-3 font-mono outline-none focus:border-[#0B3D5C]" />
          <button className="bg-[#0B3D5C] text-white font-semibold px-5 py-3 rounded-lg">View Case</button>
        </form>
      </div>
      <section>
        <h2 className="font-semibold text-slate-700 mb-2">Recent Arrivals</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {recent.map((c) => <ParamedicCaseCard key={c.encId} c={c} onOpen={() => onOpenCase(c.encId)} />)}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------- ADMIN HOME ------------------------------- */

function AdminHome({ cases, onAdmin, onOpenCase }) {
  const traumaN = cases.filter((c) => c.caseType === "trauma").length;
  const strokeN = cases.filter((c) => c.suspectedStroke).length;
  const miN = cases.filter((c) => c.suspectedMI).length;
  const completedN = cases.filter((c) => c.status === STATUS.COMPLETED).length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Administration</h1>
        <button onClick={onAdmin} className="bg-[#0B3D5C] text-white font-semibold px-4 py-2.5 rounded-lg flex items-center gap-2">
          <ShieldCheck size={16} /> Open Admin Panel
        </button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total cases" value={cases.length} icon={ClipboardList} />
        <StatCard label="Completed" value={completedN} tone="emerald" icon={CheckCircle2} />
        <StatCard label="Trauma cases" value={traumaN} icon={Bone} />
        <StatCard label="Stroke / MI flagged" value={strokeN + miN} icon={Brain} tone="rose" />
      </div>
      <div className="bg-white rounded-xl border border-slate-200">
        <div className="p-3 border-b border-slate-100 font-semibold text-sm">All Cases</div>
        <CaseTable cases={cases} loading={false} onOpenCase={onOpenCase} />
      </div>
    </div>
  );
}

/* =========================================================================
   NEW CASE (METRO INTAKE) — §3
   ========================================================================= */

function NewCaseForm({ session, onDone, onCancel, queuePending }) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    callerName: "", callerPhone: "",
    age: "", sex: "", numPatients: 1,
    address: "", landmark: "", chiefComplaint: "",
    isEmergency: true, suspectedStroke: false, suspectedMI: false, description: "",
  });
  const [decision, setDecision] = useState(null); // 'yes' | 'no'
  const [ambulanceId, setAmbulanceId] = useState("");
  const [reason, setReason] = useState("");

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function submit() {
    if (!form.chiefComplaint.trim() || !form.address.trim()) { alert("Chief complaint and address are required."); return; }
    if (!decision) { alert("Please record the ambulance decision."); return; }
    if (decision === "no" && !reason.trim()) { alert("Please record the reason ambulance was not sent."); return; }

    setSaving(true);
    try {
      const result = await db.createCase({
        caller: { name: form.callerName, phone: form.callerPhone },
        patient: {
          name: "Unknown",
          age: form.age ? Number(form.age) : null,
          sex: form.sex || "Unknown",
          numPatients: Number(form.numPatients) || 1,
        },
        incident: {
          address: form.address.trim(),
          landmark: form.landmark.trim(),
          chiefComplaint: form.chiefComplaint.trim(),
          isEmergency: !!form.isEmergency,
          suspectedStroke: !!form.suspectedStroke,
          suspectedMI: !!form.suspectedMI,
          description: form.description.trim(),
        },
        ambulanceDecision: {
          required: decision === "yes",
          reason: decision === "no" ? reason.trim() : "",
          ambulanceId: decision === "yes" ? ambulanceId : "",
        },
      }, session.token);

      // EncID is generated by PostgreSQL/backend, never by the browser.
      if (!result?.encId) throw new Error("The server did not return an EncID.");
      onDone(result.encId);
    } catch (e) {
      queuePending("New case creation", submit);
      alert(e?.message ? `Could not create case: ${e.message}` : "Could not create case on the server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold flex items-center gap-2"><Phone size={20} /> New Call — 1131 Intake</h1>
        <button onClick={onCancel} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
      </div>

      <Section title="Caller Information">
        <Grid2>
          <Field label="Caller name"><TextInput v={form.callerName} set={(v) => set("callerName", v)} /></Field>
          <Field label="Caller phone number" required><TextInput v={form.callerPhone} set={(v) => set("callerPhone", v)} type="tel" /></Field>
        </Grid2>
      </Section>

      <Section title="Patient Information">
        <Grid2>
          <Field label="Age"><TextInput v={form.age} set={(v) => set("age", v)} /></Field>
          <Field label="Sex">
            <RadioRow options={["Male", "Female", "Other", "Unknown"]} v={form.sex} set={(v) => set("sex", v)} />
          </Field>
          <Field label="Number of patients"><TextInput v={form.numPatients} set={(v) => set("numPatients", v)} type="number" /></Field>
        </Grid2>
      </Section>

      <Section title="Incident Information">
        <Field label="Exact address / location" required><TextInput v={form.address} set={(v) => set("address", v)} placeholder="Ward, Palika, street / landmark" /></Field>
        <Field label="Landmark"><TextInput v={form.landmark} set={(v) => set("landmark", v)} /></Field>
        <Field label="Chief complaint" required><TextInput v={form.chiefComplaint} set={(v) => set("chiefComplaint", v)} placeholder="In caller's own words" /></Field>
        <Grid2>
          <Field label="Call type">
            <RadioRow options={["Emergency", "Non-Emergency"]} v={form.isEmergency ? "Emergency" : "Non-Emergency"} set={(v) => set("isEmergency", v === "Emergency")} />
          </Field>
          <Field label="Life-threatening problem?">
            <YesNo v={form.isEmergency} />
          </Field>
        </Grid2>
        <Grid2>
          <Field label="Suspected stroke?"><ToggleYesNo v={form.suspectedStroke} set={(v) => set("suspectedStroke", v)} /></Field>
          <Field label="Suspected MI?"><ToggleYesNo v={form.suspectedMI} set={(v) => set("suspectedMI", v)} /></Field>
        </Grid2>
        <Field label="Additional description"><TextArea v={form.description} set={(v) => set("description", v)} /></Field>
      </Section>

      <Section title="Ambulance Decision">
        <div className="flex gap-3">
          <button onClick={() => setDecision("yes")} className={`flex-1 py-4 rounded-xl border-2 font-bold text-lg ${decision === "yes" ? "border-emerald-500 bg-emerald-50 text-emerald-800" : "border-slate-200"}`}>
            AMBULANCE REQUIRED
          </button>
          <button onClick={() => setDecision("no")} className={`flex-1 py-4 rounded-xl border-2 font-bold text-lg ${decision === "no" ? "border-rose-500 bg-rose-50 text-rose-800" : "border-slate-200"}`}>
            AMBULANCE NOT REQUIRED
          </button>
        </div>
        {decision === "yes" && (
          <div className="mt-4">
            <Field label="Assign ambulance (optional at this stage)">
              <select value={ambulanceId} onChange={(e) => setAmbulanceId(e.target.value)} className="border border-slate-300 rounded-lg px-3 py-2.5 w-full">
                <option value="">Unassigned — send to paramedic queue</option>
                {AMBULANCES.map((a) => <option key={a}>{a}</option>)}
              </select>
            </Field>
          </div>
        )}
        {decision === "no" && (
          <div className="mt-4">
            <Field label="Reason ambulance not required" required><TextArea v={reason} set={setReason} /></Field>
          </div>
        )}
      </Section>

      <button disabled={saving} onClick={submit} className="w-full bg-[#0B3D5C] disabled:opacity-50 text-white font-bold text-lg py-4 rounded-xl flex items-center justify-center gap-2">
        <Save size={18} /> {saving ? "Saving…" : "Create Case & Generate EncID"}
      </button>
    </div>
  );
}

/* --- small form primitives --- */
function Section({ title, children }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
      <h3 className="font-semibold text-slate-800">{title}</h3>
      {children}
    </div>
  );
}
function Grid2({ children }) { return <div className="grid sm:grid-cols-2 gap-3">{children}</div>; }
function Field({ label, required, children }) {
  return (
    <div>
      <label className="text-sm font-medium text-slate-600 flex items-center gap-1">
        {label} {required && <span className="text-rose-500">*</span>}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
function TextInput({ v, set, type = "text", placeholder }) {
  return <input type={type} value={v} onChange={(e) => set(e.target.value)} placeholder={placeholder}
    className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0B3D5C]" />;
}
function TextArea({ v, set, rows = 3 }) {
  return <textarea value={v} onChange={(e) => set(e.target.value)} rows={rows}
    className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0B3D5C]" />;
}
function RadioRow({ options, v, set }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button key={o} type="button" onClick={() => set(o)}
          className={`px-4 py-2.5 rounded-lg border font-medium text-sm ${v === o ? "border-[#0B3D5C] bg-[#0B3D5C] text-white" : "border-slate-300 text-slate-700"}`}>
          {o}
        </button>
      ))}
    </div>
  );
}
function ToggleYesNo({ v, set }) {
  return (
    <div className="flex gap-2">
      <button type="button" onClick={() => set(true)} className={`flex-1 py-2.5 rounded-lg border font-bold ${v === true ? "border-rose-500 bg-rose-50 text-rose-700" : "border-slate-300"}`}>YES</button>
      <button type="button" onClick={() => set(false)} className={`flex-1 py-2.5 rounded-lg border font-bold ${v === false ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-300"}`}>NO</button>
    </div>
  );
}
function YesNo({ v }) {
  return <div className={`px-4 py-2.5 rounded-lg border font-bold text-center ${v ? "border-rose-500 bg-rose-50 text-rose-700" : "border-emerald-500 bg-emerald-50 text-emerald-700"}`}>{v ? "YES" : "NO"}</div>;
}

/* =========================================================================
   CASE WORKSPACE (paramedic-centric, but shared read across roles)
   ========================================================================= */

function CaseWorkspace({ encId, session, onClose, queuePending }) {
  const [c, setC] = useState(null);
  const [tab, setTab] = useState("overview");
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const saveTimer = useRef(null);

  const load = useCallback(async () => {
    const found = await db.getCase(encId, session.token);
    setC(found);
  }, [encId]);

  useEffect(() => { load(); }, [load]);

  const persist = useCallback(async (updater, auditAction) => {
    if (!c) return;
    setSaveState("saving");
    const prev = JSON.parse(JSON.stringify(c));
    const next = JSON.parse(JSON.stringify(c));

    try { updater(next);
      const handoverChanged = JSON.stringify(prev.handover) !== JSON.stringify(next.handover);
      const summaryChanged = (prev.summary?.text || "") !== (next.summary?.text || "");
      const closing = auditAction === "Case closed" || next.status === STATUS.COMPLETED && prev.status !== STATUS.COMPLETED;

      if (handoverChanged) {
        await apiRequest(`/cases/${encodeURIComponent(next.encId)}/handover`, {
          token: session.token,
          method: "PATCH",
          body: JSON.stringify({
            facility: next.handover.facility || "",
            department: next.handover.department || "",
            receivingPerson: next.handover.receivingPerson || "",
            conditionAtHandover: next.handover.conditionAtHandover || "",
            treatmentProvided: next.handover.treatmentProvided || "",
            provisionalDiagnosis: next.handover.provisionalDiagnosis || "",
            findings: next.handover.findings || "",
            notes: next.handover.notes || "",
            markArrival: !prev.handover.arrivalTime && !!next.handover.arrivalTime,
            markHandover: !prev.handover.handoverTime && !!next.handover.handoverTime,
          }),
        });
      }

      if (summaryChanged && !closing) {
        await apiRequest(`/cases/${encodeURIComponent(next.encId)}/summary`, {
          token: session.token,
          method: "PATCH",
          body: JSON.stringify({ summaryText: next.summary.text || "" }),
        });
      }

      if (closing) {
        await apiRequest(`/cases/${encodeURIComponent(next.encId)}/close`, {
          token: session.token,
          method: "POST",
          body: JSON.stringify({ summaryText: next.summary.text || "" }),
        });
      }

      if (auditAction) {
        next.auditLog = [...(next.auditLog || []), {
          ts: Date.now(), user: session.name, role: session.role, action: auditAction,
        }];
      }
      setC(next);
      setSaveState("saved");
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSaveState("idle"), 1800);
    } catch (err) {
      setSaveState("error");
      throw err;
    }
  }, [c, session]);


  if (!c) {
    return (
      <div className="max-w-lg mx-auto bg-white border border-slate-200 rounded-xl p-8 text-center">
        <div className="text-slate-400 mb-2">Looking up case…</div>
        <div className="font-mono text-sm">{encId}</div>
        <p className="text-xs text-slate-400 mt-3">If this EncID doesn't exist yet, check the token and try again from the dashboard.</p>
        <button onClick={onClose} className="mt-4 text-[#0B3D5C] font-semibold text-sm">← Back to dashboard</button>
      </div>
    );
  }

  const isParamedic = session.role === "PARAMEDIC";
  const readOnly = !isParamedic || c.status === STATUS.COMPLETED;

  const tabs = [
    { key: "overview", label: "Overview", icon: FileText },
    { key: "timeline", label: "Timeline", icon: Clock },
    { key: "abcde", label: "XABCDE", icon: Stethoscope },
    { key: "special", label: CASE_TYPES.find((t) => t.key === c.assessment.caseType)?.label || "Case Type", icon: c.assessment.caseType === "trauma" ? Bone : Brain },
    { key: "vitals", label: "Vitals", icon: Activity },
    { key: "tx", label: "Meds / Interventions", icon: Pill },
    { key: "destination", label: "Destination", icon: Building2 },
    { key: "handover", label: "Handover / Summary", icon: ClipboardCheck },
    { key: "qr", label: "QR / Doctor View", icon: QrCode },
    { key: "audit", label: "Audit Log", icon: History },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><ChevronLeft size={22} /></button>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-lg">{c.encId}</span>
              <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_COLOR[c.status]}`}>{STATUS_LABEL[c.status]}</span>
              {readOnly && <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full flex items-center gap-1"><Lock size={10} /> Read-only</span>}
            </div>
            <div className="text-sm text-slate-500">{c.patient.age && `Age: ${c.patient.age}`} {c.patient.sex && `· ${c.patient.sex}`}</div>
          </div>
        </div>
        <SaveIndicator state={saveState} />
      </div>

      <ProgressStrip c={c} />

      <div className="flex gap-1 overflow-x-auto pb-1 border-b border-slate-200">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg whitespace-nowrap ${tab === t.key ? "bg-white border border-b-0 border-slate-200 text-[#0B3D5C]" : "text-slate-600"}`}>
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      <div>
        {tab === "overview" && <OverviewTab c={c} />}
        {tab === "timeline" && <TimelineTab c={c} persist={persist} readOnly={readOnly} session={session} />}
        {tab === "abcde" && <ABCDETab c={c} persist={persist} readOnly={readOnly} />}
        {tab === "special" && <SpecialTab c={c} persist={persist} readOnly={readOnly} />}
        {tab === "vitals" && <VitalsTab c={c} persist={persist} readOnly={readOnly} session={session} />}
        {tab === "tx" && <TxTab c={c} persist={persist} readOnly={readOnly} session={session} />}
        {tab === "destination" && <DestinationTab c={c} persist={persist} readOnly={readOnly} session={session} />}
        {tab === "handover" && <HandoverTab c={c} persist={persist} readOnly={readOnly} session={session} />}
        {tab === "qr" && <QRTab c={c} session={session} />}
        {tab === "audit" && <AuditTab c={c} />}
      </div>
    </div>
  );
}

function SaveIndicator({ state }) {
  if (state === "saving") return <span className="text-xs text-slate-400 flex items-center gap-1"><RefreshCw size={12} className="animate-spin" /> Saving…</span>;
  if (state === "saved") return <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle2 size={12} /> Saved</span>;
  if (state === "error") return <span className="text-xs text-rose-600 flex items-center gap-1"><AlertTriangle size={12} /> Not synced — will retry</span>;
  return null;
}

function ProgressStrip({ c }) {
  const steps = [
    { done: c.timeline.some((t) => t.type === "DISPATCHED"), label: "Dispatch" },
    { done: c.timeline.some((t) => t.type === "ARRIVED_AT_SITE"), label: "Scene arrival" },
    { done: c.timeline.some((t) => t.type === "PATIENT_ASSESSED"), label: "Assessment" },
    { done: c.timeline.some((t) => t.type === "ARRIVED_HOSPITAL"), label: "Transport" },
    { done: !!c.handover.handoverTime, label: "Handover" },
    { done: !!c.summary.closedAt, label: "Final summary" },
  ];
  return (
    <div className="flex flex-wrap gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm">
      {steps.map((s, i) => (
        <span key={i} className={`flex items-center gap-1.5 ${s.done ? "text-emerald-600" : "text-slate-400"}`}>
          {s.done ? <CheckCircle2 size={15} /> : <Circle size={15} />} {s.label}
        </span>
      ))}
    </div>
  );
}

/* --------------------------------- OVERVIEW -------------------------------- */

function OverviewTab({ c }) {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Section title="Caller">
        <KV k="Name" v={c.caller.name} /><KV k="Phone" v={c.caller.phone} />
      </Section>
      <Section title="Patient">
        <KV k="Age" v={c.patient.age} /><KV k="Sex" v={c.patient.sex} /><KV k="Number of patients" v={c.patient.numPatients} />
      </Section>
      <Section title="Incident">
        <KV k="Address" v={c.incident.address} /><KV k="Landmark" v={c.incident.landmark} /><KV k="Chief complaint" v={c.incident.chiefComplaint} />
        <KV k="Type" v={c.incident.isEmergency ? "Emergency" : "Non-emergency"} />
        <KV k="Suspected stroke" v={c.incident.suspectedStroke ? "Yes" : "No"} />
        <KV k="Suspected MI" v={c.incident.suspectedMI ? "Yes" : "No"} />
        <KV k="Description" v={c.incident.description} />
      </Section>
      <Section title="Ambulance Decision">
        <KV k="Required" v={c.ambulanceDecision.required ? "Yes" : "No"} />
        {c.ambulanceDecision.required ? <KV k="Ambulance" v={c.ambulanceDecision.ambulanceId || "Unassigned"} /> : <KV k="Reason" v={c.ambulanceDecision.reason} />}
        <KV k="Decided by" v={`${c.ambulanceDecision.decidedBy} · ${fmtTime(c.ambulanceDecision.decidedAt)}`} />
      </Section>
    </div>
  );
}
function KV({ k, v }) {
  return (
    <div className="flex justify-between text-sm border-b border-slate-50 py-1.5">
      <span className="text-slate-500">{k}</span><span className="font-medium text-right">{v || "—"}</span>
    </div>
  );
}

/* --------------------------------- TIMELINE -------------------------------- */

function TimelineTab({ c, persist, readOnly, session }) {
  const done = new Set(c.timeline.map((t) => t.type));
  const nextIdx = TIMELINE_STEPS.findIndex((s) => !done.has(s.key));
  const isParamedic = session.role === "PARAMEDIC";
  const canRecordStep = () => !readOnly && isParamedic;

  function pressStep(step) {
    persist((next) => {
      next.timeline.push({ type: step.key, ts: Date.now(), user: session.name, notes: "" });
      next.status = step.status;
    }, `${step.label} recorded`);
  }

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Section title="Dispatch Timeline">
        <div className="space-y-2">
          {TIMELINE_STEPS.map((step, i) => {
            const evt = c.timeline.find((t) => t.type === step.key);
            const isNext = i === nextIdx;
            return (
              <div key={step.key} className={`flex items-center justify-between rounded-lg border p-3 ${evt ? "bg-emerald-50 border-emerald-200" : isNext ? "bg-blue-50 border-blue-300" : "bg-slate-50 border-slate-200"}`}>
                <div className="flex items-center gap-2">
                  {evt ? <CheckCircle2 className="text-emerald-600" size={18} /> : <Circle className="text-slate-400" size={18} />}
                  <div>
                    <div className="font-medium text-sm">{step.label}</div>
                    {evt && <div className="text-xs text-slate-500">{fmtTime(evt.ts)} · {evt.user}</div>}
                  </div>
                </div>
                {!evt && isNext && canRecordStep(step) && (
                  <button onClick={() => pressStep(step)} className="bg-[#0B3D5C] text-white text-sm font-semibold px-4 py-2 rounded-lg flex items-center gap-1">
                    Mark <ArrowRight size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-slate-400 mt-2">
          Only paramedics can record timeline events. Other roles have read-only access.
        </p>
      </Section>
      <Section title="Case Type (drives Special tab)">
        <p className="text-xs text-slate-500 mb-2">Set based on Metro intake; adjust if on-scene findings differ.</p>
        <div className="grid grid-cols-2 gap-2">
          {CASE_TYPES.map((t) => (
            <button key={t.key} disabled={readOnly} onClick={() => persist((n) => { n.assessment.caseType = t.key; }, `Case type set to ${t.label}`)}
              className={`px-3 py-2.5 rounded-lg border text-sm font-medium ${c.assessment.caseType === t.key ? "border-[#0B3D5C] bg-[#0B3D5C] text-white" : "border-slate-300"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}

/* --------------------------------- ABCDE ------------------------------------ */

function ABCDETab({ c, persist, readOnly }) {
  const a = c.assessment;
  const upd = (section, patch, label) =>
  persist((n) => {
    n.assessment[section] = {
      ...(n.assessment[section] || {}),
      ...patch,
    };
  }, `${label} updated`);

  return (
    <div className="space-y-4">

     <Section title="X — Exsanguination / Catastrophic Hemorrhage">

  <Field label="Bleeding">
    <RadioRow
      options={["No catastrophic bleeding", "Catastrophic bleeding"]}
      v={a.x?.bleeding || "No catastrophic bleeding"}
      set={(v) =>
        !readOnly &&
        upd("x", { bleeding: v }, "X — Bleeding")
      }
    />
  </Field>

  <Field label="Intervention">
    <div className="grid sm:grid-cols-2 gap-2">
      {[
        "Tourniquet applied",
        "Direct pressure/compression",
        "Hemostatic dressing applied",
        "Wound packing",
        "Pressure dressing applied",
        "Other intervention",
      ].map((item) => {
        const selected = (a.x?.intervention || "")
          .split(" | ")
          .filter(Boolean)
          .includes(item);

        return (
          <label
            key={item}
            className="flex items-center gap-2 border border-slate-200 rounded-lg px-3 py-2 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={selected}
              disabled={readOnly}
              onChange={(e) => {
                const current = (a.x?.intervention || "")
                  .split(" | ")
                  .filter(Boolean);

                const next = e.target.checked
                  ? [...current, item]
                  : current.filter((x) => x !== item);

                upd(
                  "x",
                  { intervention: next.join(" | ") },
                  `X intervention: ${item}`
                );
              }}
            />
            <span>{item}</span>
          </label>
        );
      })}
    </div>
  </Field>

  <Grid2>
    <Field label="Bleeding controlled">
      <RadioRow
        options={["Yes", "No"]}
        v={a.x?.bleedingControlled || ""}
        set={(v) =>
          !readOnly &&
          upd(
            "x",
            { bleedingControlled: v },
            "Bleeding controlled"
          )
        }
      />
    </Field>

    <Field label="Site">
      <TextInput
        v={a.x?.site || ""}
        set={(v) =>
          !readOnly &&
          upd("x", { site: v }, "Bleeding site")
        }
      />
    </Field>
  </Grid2>

  <Grid2>
    <Field label="Tourniquet time">
      <TextInput
        v={a.x?.tourniquetTime || ""}
        set={(v) =>
          !readOnly &&
          upd("x", { tourniquetTime: v }, "Tourniquet time")
        }
      />
    </Field>

    <Field label="Intervention details/remarks">
      <TextArea
        v={a.x?.remarks || ""}
        set={(v) =>
          !readOnly &&
          upd("x", { remarks: v }, "X intervention remarks")
        }
        rows={2}
      />
    </Field>
  </Grid2>

</Section>

      {/* A — Airway */}
      <Section title="A — Airway">
        <Grid2>
          <Field label="Status">
            <RadioRow
              options={["Patent", "Compromised", "Obstructed"]}
              v={a.airway.status}
              set={(v) =>
                !readOnly &&
                upd("airway", { status: v }, "Airway status")
              }
            />
          </Field>

          <Field label="Intervention">
            <TextInput
              v={a.airway.intervention}
              set={(v) =>
                !readOnly &&
                upd(
                  "airway",
                  { intervention: v },
                  "Airway intervention"
                )
              }
            />
          </Field>
        </Grid2>

        <Field label="Notes">
          <TextArea
            v={a.airway.notes}
            set={(v) =>
              !readOnly &&
              upd("airway", { notes: v }, "Airway notes")
            }
            rows={2}
          />
        </Field>
      </Section>

      {/* B — Breathing */}
      <Section title="B — Breathing">
        <div className="grid sm:grid-cols-4 gap-3">
          <Field label="Resp. rate">
            <TextInput
              v={a.breathing.rr}
              set={(v) =>
                !readOnly &&
                upd("breathing", { rr: v }, "RR")
              }
            />
          </Field>

          <Field label="SpO2 %">
            <TextInput
              v={a.breathing.spo2}
              set={(v) =>
                !readOnly &&
                upd("breathing", { spo2: v }, "SpO2")
              }
            />
          </Field>

          <Field label="Distress">
            <RadioRow
              options={["None", "Mild", "Severe"]}
              v={a.breathing.distress}
              set={(v) =>
                !readOnly &&
                upd("breathing", { distress: v }, "Distress")
              }
            />
          </Field>

          <Field label="Oxygen given">
            <TextInput
              v={a.breathing.o2}
              set={(v) =>
                !readOnly &&
                upd("breathing", { o2: v }, "O2")
              }
              placeholder="e.g. 4L NC"
            />
          </Field>
        </div>

        <Field label="Notes">
          <TextArea
            v={a.breathing.notes}
            set={(v) =>
              !readOnly &&
              upd(
                "breathing",
                { notes: v },
                "Breathing notes"
              )
            }
            rows={2}
          />
        </Field>
      </Section>

      {/* C — Circulation */}
      <Section title="C — Circulation">
        <div className="grid sm:grid-cols-4 gap-3">
          <Field label="Pulse">
            <TextInput
              v={a.circulation.pulse}
              set={(v) =>
                !readOnly &&
                upd("circulation", { pulse: v }, "Pulse")
              }
            />
          </Field>

          <Field label="BP">
            <TextInput
              v={a.circulation.bp}
              set={(v) =>
                !readOnly &&
                upd("circulation", { bp: v }, "BP")
              }
              placeholder="120/80"
            />
          </Field>

          <Field label="Cap refill">
            <TextInput
              v={a.circulation.capRefill}
              set={(v) =>
                !readOnly &&
                upd(
                  "circulation",
                  { capRefill: v },
                  "Cap refill"
                )
              }
            />
          </Field>

          <Field label="Bleeding">
            <TextInput
              v={a.circulation.bleeding}
              set={(v) =>
                !readOnly &&
                upd(
                  "circulation",
                  { bleeding: v },
                  "Bleeding"
                )
              }
            />
          </Field>
        </div>

        <Field label="IV access">
          <TextInput
            v={a.circulation.ivAccess}
            set={(v) =>
              !readOnly &&
              upd(
                "circulation",
                { ivAccess: v },
                "IV access"
              )
            }
          />
        </Field>

        <Field label="Notes">
          <TextArea
            v={a.circulation.notes}
            set={(v) =>
              !readOnly &&
              upd(
                "circulation",
                { notes: v },
                "Circulation notes"
              )
            }
            rows={2}
          />
        </Field>
      </Section>

      {/* D — Disability */}
      <Section title="D — Disability">
        <div className="grid sm:grid-cols-4 gap-3">
          <Field label="GCS">
            <TextInput
              v={a.disability.gcs}
              set={(v) =>
                !readOnly &&
                upd("disability", { gcs: v }, "GCS")
              }
            />
          </Field>

          <Field label="Blood glucose">
            <TextInput
              v={a.disability.glucose}
              set={(v) =>
                !readOnly &&
                upd(
                  "disability",
                  { glucose: v },
                  "Glucose"
                )
              }
            />
          </Field>

          <Field label="Pupils">
            <TextInput
              v={a.disability.pupils}
              set={(v) =>
                !readOnly &&
                upd(
                  "disability",
                  { pupils: v },
                  "Pupils"
                )
              }
            />
          </Field>

          <Field label="Seizure">
            <RadioRow
              options={["No", "Yes"]}
              v={a.disability.seizure}
              set={(v) =>
                !readOnly &&
                upd(
                  "disability",
                  { seizure: v },
                  "Seizure"
                )
              }
            />
          </Field>
        </div>

        <Field label="Neurological findings">
          <TextArea
            v={a.disability.neuro}
            set={(v) =>
              !readOnly &&
              upd(
                "disability",
                { neuro: v },
                "Neuro findings"
              )
            }
            rows={2}
          />
        </Field>
      </Section>

      {/* E — Exposure / Examination */}
      <Section title="E — Exposure / Examination">
        <Grid2>
          <Field label="Temperature">
            <TextInput
              v={a.exposure.temp}
              set={(v) =>
                !readOnly &&
                upd("exposure", { temp: v }, "Temp")
              }
            />
          </Field>

          <Field label="Injuries">
            <TextInput
              v={a.exposure.injuries}
              set={(v) =>
                !readOnly &&
                upd(
                  "exposure",
                  { injuries: v },
                  "Injuries"
                )
              }
            />
          </Field>
        </Grid2>

        <Field label="Relevant exam findings">
          <TextArea
            v={a.exposure.findings}
            set={(v) =>
              !readOnly &&
              upd(
                "exposure",
                { findings: v },
                "Exam findings"
              )
            }
            rows={2}
          />
        </Field>
      </Section>

    </div>
  );
}/* ------------------------------- SPECIAL / CASE-TYPE -------------------------- */

function SpecialTab({ c, persist, readOnly }) {
  const type = c.assessment.caseType;
  if (type === "stroke") return <StrokeBlock c={c} persist={persist} readOnly={readOnly} />;
  if (type === "mi") return <MIBlock c={c} persist={persist} readOnly={readOnly} />;
  if (type === "trauma") return <TraumaBlock c={c} persist={persist} readOnly={readOnly} />;
  return <div className="bg-white border border-dashed border-slate-200 rounded-xl p-8 text-center text-slate-400 text-sm">General medical case — no additional module required beyond ABCDE.</div>;
}

function StrokeBlock({ c, persist, readOnly }) {
  const s = c.assessment.stroke;
  const upd = (patch, label) => persist((n) => Object.assign(n.assessment.stroke, patch), label);
  return (
    <Section title="Suspected Stroke — BE-FAST Assessment">
      <Field label="Time of onset / last known well" required>
        <input type="datetime-local" disabled={readOnly} value={s.lastKnownWell} onChange={(e) => upd({ lastKnownWell: e.target.value }, "Last known well time")}
          className="border-2 border-amber-400 bg-amber-50 rounded-lg px-3 py-2.5 font-semibold" />
      </Field>
      <div className="grid sm:grid-cols-2 gap-3 mt-2">
        {[["balance", "Balance"], ["eyes", "Eyes"], ["face", "Face"], ["arm", "Arm"], ["speech", "Speech"]].map(([k, label]) => (
          <Field key={k} label={label}><TextInput v={s[k]} set={(v) => !readOnly && upd({ [k]: v }, `BE-FAST ${label}`)} placeholder="Findings" /></Field>
        ))}
      </div>
    </Section>
  );
}
function MIBlock({ c, persist, readOnly }) {
  const m = c.assessment.mi;
  const upd = (patch, label) => persist((n) => Object.assign(n.assessment.mi, patch), label);
  return (
    <Section title="Suspected MI — Cardiac Assessment">
      <Field label="Time of onset"><input type="datetime-local" disabled={readOnly} value={m.onsetTime} onChange={(e) => upd({ onsetTime: e.target.value }, "Chest pain onset")} className="border border-slate-300 rounded-lg px-3 py-2.5 w-full" disabled={readOnly} /></Field>
      <Field label="Current symptoms"><TextArea v={m.symptoms} set={(v) => !readOnly && upd({ symptoms: v }, "Cardiac symptoms")} /></Field>
      <Field label="Known cardiac history"><TextArea v={m.cardiacHistory} set={(v) => !readOnly && upd({ cardiacHistory: v }, "Cardiac history")} rows={2} /></Field>
    </Section>
  );
}
function TraumaBlock({ c, persist, readOnly }) {
  const t = c.assessment.trauma;
  const upd = (patch, label) => persist((n) => Object.assign(n.assessment.trauma, patch), label);
  const toggleLoc = (loc) => {
    const has = t.injuryLocations.includes(loc);
    upd({ injuryLocations: has ? t.injuryLocations.filter((x) => x !== loc) : [...t.injuryLocations, loc] }, "Injury location");
  };
  return (
    <Section title="Trauma Assessment">
      <Field label="Mechanism of injury"><RadioRow options={MECHANISMS} v={t.mechanism} set={(v) => !readOnly && upd({ mechanism: v }, "Mechanism")} /></Field>
      <Field label="Injury location(s)">
        <div className="flex flex-wrap gap-2">
          {INJURY_LOCATIONS.map((loc) => (
            <button key={loc} disabled={readOnly} onClick={() => toggleLoc(loc)}
              className={`px-3 py-2 rounded-lg border text-sm font-medium ${t.injuryLocations.includes(loc) ? "border-[#0B3D5C] bg-[#0B3D5C] text-white" : "border-slate-300"}`}>
              {loc}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Findings"><TextArea v={t.findings} set={(v) => !readOnly && upd({ findings: v }, "Trauma findings")} /></Field>
      <Field label="Notes"><TextArea v={t.notes} set={(v) => !readOnly && upd({ notes: v }, "Trauma notes")} rows={2} /></Field>
    </Section>
  );
}

/* ---------------------------------- VITALS ------------------------------------ */

function VitalsTab({ c, persist, readOnly, session }) {
  const [form, setForm] = useState({ bp: "", pulse: "", rr: "", spo2: "", gcs: "", temp: "" });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const isParamedic = session.role === "PARAMEDIC";

  function addVital() {
    if (!isParamedic) return;
    persist((n) => { n.vitals.push({ ts: Date.now(), user: session.name, role: session.role, ...form }); }, "Vitals recorded");
    setForm({ bp: "", pulse: "", rr: "", spo2: "", gcs: "", temp: "" });
  }

  return (
    <div className="space-y-4">
      {isParamedic && !readOnly && (
        <Section title="Record New Vitals">
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            <Field label="BP"><TextInput v={form.bp} set={(v) => set("bp", v)} placeholder="120/80" /></Field>
            <Field label="Pulse"><TextInput v={form.pulse} set={(v) => set("pulse", v)} /></Field>
            <Field label="RR"><TextInput v={form.rr} set={(v) => set("rr", v)} /></Field>
            <Field label="SpO2%"><TextInput v={form.spo2} set={(v) => set("spo2", v)} /></Field>
            <Field label="GCS"><TextInput v={form.gcs} set={(v) => set("gcs", v)} /></Field>
            <Field label="Temp"><TextInput v={form.temp} set={(v) => set("temp", v)} /></Field>
          </div>
          <button onClick={addVital} className="mt-2 bg-[#0B3D5C] text-white font-semibold px-4 py-2.5 rounded-lg flex items-center gap-2">
            <Plus size={16} /> Add Reading
          </button>
        </Section>
      )}
      <Section title={`Vitals History (${c.vitals.length})`}>
        {c.vitals.length === 0 ? <div className="text-sm text-slate-400">No readings recorded yet.</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-slate-500 border-b"><th className="p-2">Time</th><th className="p-2">BP</th><th className="p-2">Pulse</th><th className="p-2">RR</th><th className="p-2">SpO2</th><th className="p-2">GCS</th><th className="p-2">Temp</th><th className="p-2">By</th></tr></thead>
              <tbody>
                {[...c.vitals].reverse().map((v, i) => (
                  <tr key={i} className="border-b border-slate-50">
                    <td className="p-2">{fmtTimeShort(v.ts)}</td><td className="p-2">{v.bp || "—"}</td><td className="p-2">{v.pulse || "—"}</td>
                    <td className="p-2">{v.rr || "—"}</td><td className="p-2">{v.spo2 || "—"}</td><td className="p-2">{v.gcs || "—"}</td><td className="p-2">{v.temp || "—"}</td>
                    <td className="p-2 text-xs text-slate-400">{v.user}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

/* ----------------------------- MEDS / INTERVENTIONS ---------------------------- */

function TxTab({ c, persist, readOnly, session }) {
  const [med, setMed] = useState({ medication: "", dose: "", route: "", notes: "" });
  const [iv, setIv] = useState({ type: "Oxygen", notes: "" });

  function addMed() {
    if (!med.medication.trim()) return;
    persist((n) => { n.medications.push({ ts: Date.now(), user: session.name, ...med }); }, `Medication given: ${med.medication}`);
    setMed({ medication: "", dose: "", route: "", notes: "" });
  }
  function addIv() {
    persist((n) => { n.interventions.push({ ts: Date.now(), user: session.name, ...iv }); }, `Intervention: ${iv.type}`);
    setIv({ type: "Oxygen", notes: "" });
  }

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Section title="Medications">
        {!readOnly && (
          <div className="space-y-2 bg-slate-50 rounded-lg p-3">
            <div className="grid grid-cols-2 gap-2">
              <TextInput v={med.medication} set={(v) => setMed({ ...med, medication: v })} placeholder="Medication" />
              <TextInput v={med.dose} set={(v) => setMed({ ...med, dose: v })} placeholder="Dose" />
              <TextInput v={med.route} set={(v) => setMed({ ...med, route: v })} placeholder="Route (IV/IM/PO)" />
              <TextInput v={med.notes} set={(v) => setMed({ ...med, notes: v })} placeholder="Notes" />
            </div>
            <button onClick={addMed} className="bg-[#0B3D5C] text-white text-sm font-semibold px-4 py-2 rounded-lg flex items-center gap-1"><Syringe size={14} /> Add Medication</button>
          </div>
        )}
        <div className="mt-2 divide-y divide-slate-50">
          {c.medications.length === 0 && <div className="text-sm text-slate-400">None recorded.</div>}
          {[...c.medications].reverse().map((m, i) => (
            <div key={i} className="py-2 text-sm flex justify-between">
              <span><strong>{m.medication}</strong> {m.dose} {m.route}</span>
              <span className="text-xs text-slate-400">{fmtTimeShort(m.ts)}</span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Interventions">
        {!readOnly && (
          <div className="space-y-2 bg-slate-50 rounded-lg p-3">
            <select value={iv.type} onChange={(e) => setIv({ ...iv, type: e.target.value })} className="w-full border border-slate-300 rounded-lg px-3 py-2.5">
              {INTERVENTION_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
            <TextInput v={iv.notes} set={(v) => setIv({ ...iv, notes: v })} placeholder="Notes" />
            <button onClick={addIv} className="bg-[#0B3D5C] text-white text-sm font-semibold px-4 py-2 rounded-lg flex items-center gap-1"><Droplet size={14} /> Add Intervention</button>
          </div>
        )}
        <div className="mt-2 divide-y divide-slate-50">
          {c.interventions.length === 0 && <div className="text-sm text-slate-400">None recorded.</div>}
          {[...c.interventions].reverse().map((v, i) => (
            <div key={i} className="py-2 text-sm flex justify-between">
              <span><strong>{v.type}</strong> {v.notes && `— ${v.notes}`}</span>
              <span className="text-xs text-slate-400">{fmtTimeShort(v.ts)}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

/* ------------------------------- DESTINATION / CONSENT -------------------------- */

function DestinationTab({ c, persist, readOnly, session }) {
  const [alt, setAlt] = useState({ name: "", reason: "", consentName: "", relation: "" });

  function chooseFacility(name) {
    persist((n) => { n.destination = { facility: name, isAlternative: false, consent: null }; }, `Destination selected: ${name}`);
  }
  function submitAlternative() {
    if (!alt.name.trim() || !alt.reason.trim() || !alt.consentName.trim()) { alert("Alternative facility, reason, and consenting person are required."); return; }
    persist((n) => {
      n.destination = {
        facility: alt.name, isAlternative: true,
        consent: { reason: alt.reason, consentName: alt.consentName, relation: alt.relation, ts: Date.now() },
      };
    }, `Alternative destination selected: ${alt.name} (consent recorded)`);
  }

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Section title="Approved Government Facilities">
        <div className="space-y-2">
          {FACILITIES.map((f) => (
            <button key={f} disabled={readOnly} onClick={() => chooseFacility(f)}
              className={`w-full text-left px-4 py-3 rounded-lg border ${c.destination.facility === f && !c.destination.isAlternative ? "border-[#0B3D5C] bg-[#0B3D5C]/5" : "border-slate-200"}`}>
              {f}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Alternative / Non-Listed Destination">
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
          If the patient/relative insists on a facility outside the approved list, consent must be recorded before the case can be closed.
        </p>
        {c.destination.isAlternative ? (
          <div className="text-sm space-y-1 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
            <div className="font-semibold text-emerald-800">Alternative destination recorded</div>
            <KV k="Facility" v={c.destination.facility} />
            <KV k="Reason" v={c.destination.consent?.reason} />
            <KV k="Consent given by" v={`${c.destination.consent?.consentName} (${c.destination.consent?.relation || "relation not specified"})`} />
            <KV k="Recorded at" v={fmtTime(c.destination.consent?.ts)} />
          </div>
        ) : !readOnly && (
          <div className="space-y-2">
            <TextInput v={alt.name} set={(v) => setAlt({ ...alt, name: v })} placeholder="Alternative hospital name" />
            <TextArea v={alt.reason} set={(v) => setAlt({ ...alt, reason: v })} rows={2} />
            <div className="grid grid-cols-2 gap-2">
              <TextInput v={alt.consentName} set={(v) => setAlt({ ...alt, consentName: v })} placeholder="Name of person giving consent" />
              <TextInput v={alt.relation} set={(v) => setAlt({ ...alt, relation: v })} placeholder="Relationship to patient" />
            </div>
            <button onClick={submitAlternative} className="w-full bg-amber-600 text-white font-semibold py-2.5 rounded-lg">Record Consent &amp; Set Destination</button>
          </div>
        )}
      </Section>
    </div>
  );
}

/* ------------------------------- HANDOVER / SUMMARY / CLOSE --------------------- */

function HandoverTab({ c, persist, readOnly, session }) {
  const h = c.handover || {};
  const upd = (patch, label) => persist((n) => { n.handover = { ...(n.handover || {}), ...patch }; }, label);
  const [summaryText, setSummaryText] = useState(c.summary?.text || "");

  const canClose = !!h.handoverTime && !!summaryText.trim() && (!c.destination.isAlternative || !!c.destination.consent) && c.status !== STATUS.COMPLETED;
  const blockers = [];
  if (!h.handoverTime) blockers.push("Handover time not recorded");
  if (!summaryText.trim()) blockers.push("Final pre-hospital summary not written");
  if (c.destination.isAlternative && !c.destination.consent) blockers.push("Consent for alternative destination missing");

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Section title="Handover at Receiving Facility">
        <Field label="Facility"><TextInput v={h.facility || c.destination.facility} set={(v) => !readOnly && upd({ facility: v })} /></Field>
        <Grid2>
          <Field label="Arrival time">
            <button disabled={readOnly || !!h.arrivalTime} onClick={() => upd({ arrivalTime: Date.now() }, "Hospital arrival recorded")}
              className={`w-full py-2.5 rounded-lg border font-semibold ${h.arrivalTime ? "bg-emerald-50 border-emerald-300 text-emerald-800" : "border-slate-300"}`}>
              {h.arrivalTime ? fmtTime(h.arrivalTime) : "Mark Arrived"}
            </button>
          </Field>
          <Field label="Handover time">
            <button disabled={readOnly || !!h.handoverTime} onClick={() => upd({ handoverTime: Date.now() }, "Patient handed over")}
              className={`w-full py-2.5 rounded-lg border font-semibold ${h.handoverTime ? "bg-emerald-50 border-emerald-300 text-emerald-800" : "border-slate-300"}`}>
              {h.handoverTime ? fmtTime(h.handoverTime) : "Mark Handed Over"}
            </button>
          </Field>
        </Grid2>
        <Grid2>
          <Field label="Receiving department"><TextInput v={h.department} set={(v) => !readOnly && upd({ department: v })} /></Field>
          <Field label="Receiving doctor / person"><TextInput v={h.receivingPerson} set={(v) => !readOnly && upd({ receivingPerson: v })} /></Field>
        </Grid2>
        <Field label="Patient condition at handover"><TextArea v={h.conditionAtHandover} set={(v) => !readOnly && upd({ conditionAtHandover: v })} rows={2} /></Field>
        <Field label="Treatment / interventions provided"><TextArea v={h.treatmentProvided} set={(v) => !readOnly && upd({ treatmentProvided: v })} rows={2} /></Field>
        <Field label="Provisional Diagnosis">
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-1 inline-block">Not a confirmed hospital diagnosis</div>
          <TextInput v={h.provisionalDiagnosis} set={(v) => !readOnly && upd({ provisionalDiagnosis: v })} />
        </Field>
        <Field label="Important clinical findings"><TextArea v={h.findings} set={(v) => !readOnly && upd({ findings: v })} rows={2} /></Field>
        <Field label="Additional notes"><TextArea v={h.notes} set={(v) => !readOnly && upd({ notes: v })} rows={2} /></Field>
      </Section>

      <Section title="Final Pre-Hospital Summary & Case Closure">
        <Field label="Concise summary of the case" required>
          <TextArea v={summaryText} set={setSummaryText} rows={6} />
        </Field>
        {!readOnly && (
          <button onClick={() => persist((n) => { n.summary.text = summaryText; }, "Final summary saved")}
            className="bg-slate-700 text-white font-semibold px-4 py-2 rounded-lg text-sm">Save Summary</button>
        )}

        {blockers.length > 0 && c.status !== STATUS.COMPLETED && (
          <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm text-rose-700">
            <div className="font-semibold mb-1">Cannot close case yet:</div>
            <ul className="list-disc pl-5">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          </div>
        )}

        {c.status === STATUS.COMPLETED ? (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-emerald-800 text-sm flex items-center gap-2">
            <BadgeCheck size={18} /> Case closed by {c.summary.closedBy} at {fmtTime(c.summary.closedAt)}
          </div>
        ) : !readOnly && (
          <button
            disabled={!canClose}
            onClick={() => persist((n) => {
              n.status = STATUS.COMPLETED;
              n.summary.text = summaryText;
              n.summary.closedBy = session.name;
              n.summary.closedAt = Date.now();
            }, "Case closed")}
            className="w-full bg-emerald-600 disabled:opacity-40 text-white font-bold py-3 rounded-xl"
          >
            CLOSE CASE
          </button>
        )}
      </Section>
    </div>
  );
}

/* ------------------------------------- QR TAB ------------------------------------ */

function QRTab({ c, session }) {
  const [qr, setQr] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setError("");
        const data = await apiRequest(`/cases/${encodeURIComponent(c.encId)}/qr`, { token: session.token });
        if (!cancelled) setQr(data);
      } catch (e) {
        if (!cancelled) setError(e.message || "Could not generate QR link");
      }
    })();
    return () => { cancelled = true; };
  }, [c.encId, session.token]);

  const doctorUrl = qr?.url || qr?.secureUrl || qr?.doctorUrl || `${window.location.origin}/doctor/case/${encodeURIComponent(c.encId)}`;

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Section title="Secure Case QR">
        <div className="flex flex-col items-center gap-3 py-4">
          {qr?.qr ? (
            <img src={qr.qr} alt={`Secure QR for ${c.encId}`} className="w-64 h-64 border-2 border-slate-200 rounded-lg bg-white p-2" />
          ) : (
            <div className="w-64 h-64 flex items-center justify-center border-2 border-slate-200 rounded-lg bg-white text-sm text-slate-400">
              {error || "Generating QR…"}
            </div>
          )}
          <a href={doctorUrl} className="font-mono text-xs text-[#0B3D5C] underline break-all text-center">
            {doctorUrl}
          </a>
          <p className="text-xs text-slate-400 text-center max-w-xs">
            Scan this QR or open the link. The link contains only the EncID; the Doctor must sign in before viewing the case.
          </p>
        </div>
      </Section>
      <Section title="Doctor View Preview">
        <DoctorViewContent c={c} />
      </Section>
    </div>
  );
}

function FakeQR({ seed }) {
  // Deterministic pseudo-random grid derived from the EncID, purely a visual
  // placeholder — see architecture note #4 at top of file.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const size = 11;
  const cells = [];
  for (let i = 0; i < size * size; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    cells.push(h % 100 < 46);
  }
  return (
    <div className="bg-white p-3 rounded-lg border-2 border-slate-200">
      <div className="grid" style={{ gridTemplateColumns: `repeat(${size}, 1fr)`, width: 176, height: 176 }}>
        {cells.map((on, i) => (
          <div key={i} style={{ background: on ? "#0B3D5C" : "transparent" }} />
        ))}
      </div>
    </div>
  );
}

function DoctorViewContent({ c }) {
  return (
    <div className="space-y-3 text-sm max-h-[420px] overflow-y-auto pr-1">
      <div><span className="text-slate-500">EncID:</span> <span className="font-mono font-semibold">{c.encId}</span></div>
      <div><span className="text-slate-500">Chief complaint:</span> {c.incident.chiefComplaint}</div>
      <div><span className="text-slate-500">Incident location:</span> {c.incident.address}</div>
      <div>
        <div className="text-slate-500 mb-1">Ambulance timeline:</div>
        {c.timeline.map((t, i) => <div key={i} className="text-xs">• {TIMELINE_STEPS.find((s) => s.key === t.type)?.label}: {fmtTime(t.ts)}</div>)}
      </div>
      <div>
        <div className="text-slate-500 mb-1">Latest vitals:</div>
        {c.vitals.length ? (() => { const v = c.vitals[c.vitals.length - 1]; return <div className="text-xs">BP {v.bp} · Pulse {v.pulse} · RR {v.rr} · SpO2 {v.spo2}% · GCS {v.gcs} · Temp {v.temp}</div>; })() : <div className="text-xs text-slate-400">No vitals recorded</div>}
      </div>
      <div><span className="text-slate-500">Provisional diagnosis:</span> {c.handover?.provisionalDiagnosis || "—"} <span className="text-xs text-amber-600">(not confirmed)</span></div>
      <div><span className="text-slate-500">Pre-hospital summary:</span> {c.summary?.text || "Pending"}</div>
      {c.destination.isAlternative && <div className="text-xs bg-amber-50 border border-amber-200 rounded p-2">Alternative destination — consent on file from {c.destination.consent?.consentName}</div>}
    </div>
  );
}

/* -------------------------------------- AUDIT TAB --------------------------------- */

function AuditTab({ c }) {
  return (
    <Section title={`Audit Trail (${c.auditLog.length} entries)`}>
      <div className="divide-y divide-slate-50 text-sm">
        {[...c.auditLog].reverse().map((a, i) => (
          <div key={i} className="py-2 flex justify-between gap-3">
            <div>
              <span className="font-medium">{a.action}</span>
              <div className="text-xs text-slate-400">{a.user} · {ROLES[a.role] || a.role}</div>
            </div>
            <div className="text-xs text-slate-400 whitespace-nowrap">{fmtTime(a.ts)}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* =========================================================================
   ADMIN PANEL — §16, §22, §23
   ========================================================================= */

function AdminPanel({ session, onOpenCase }) {
  const [tab, setTab] = useState("overview");
  const [cases, setCases] = useState([]);
  const [users, setUsers] = useState([]);
  const [facilities, setFacilities] = useState([]);
  const [ambulances, setAmbulances] = useState([]);
  const [reports, setReports] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [userForm, setUserForm] = useState({ name: "", phone: "", role: "PARAMEDIC", password: "" });
  const [facilityName, setFacilityName] = useState("");
  const [ambulanceCode, setAmbulanceCode] = useState("");

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [caseRows, userRows, facilityRows, ambulanceRows, reportData] = await Promise.all([
        apiRequest("/cases", { token: session.token }),
        apiRequest("/admin/users", { token: session.token }),
        apiRequest("/admin/facilities", { token: session.token }),
        apiRequest("/admin/ambulances", { token: session.token }),
        apiRequest("/admin/reports", { token: session.token }),
      ]);
      setCases(caseRows || []);
      setUsers(userRows || []);
      setFacilities(facilityRows || []);
      setAmbulances(ambulanceRows || []);
      setReports(reportData || null);
    } catch (e) {
      setError(e.message || "Could not load administrator data.");
    } finally {
      setLoading(false);
    }
  }, [session.token]);

  useEffect(() => { loadAll(); }, [loadAll]);

  async function createUser(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await apiRequest("/admin/users", {
        token: session.token,
        method: "POST",
        body: JSON.stringify(userForm),
      });
      setUserForm({ name: "", phone: "", role: "PARAMEDIC", password: "" });
      await loadAll();
    } catch (e) {
      setError(e.message || "Could not create user.");
    } finally { setBusy(false); }
  }

  async function toggleUser(user) {
    setBusy(true); setError("");
    try {
      await apiRequest(`/admin/users/${user.id}/active`, {
        token: session.token,
        method: "PATCH",
        body: JSON.stringify({ active: !user.active }),
      });
      await loadAll();
    } catch (e) {
      setError(e.message || "Could not update user.");
    } finally { setBusy(false); }
  }

  async function addFacility(e) {
    e.preventDefault();
    if (!facilityName.trim()) return;
    setBusy(true); setError("");
    try {
      await apiRequest("/admin/facilities", {
        token: session.token,
        method: "POST",
        body: JSON.stringify({ name: facilityName.trim(), isGovernment: true }),
      });
      setFacilityName("");
      await loadAll();
    } catch (e) {
      setError(e.message || "Could not add facility.");
    } finally { setBusy(false); }
  }

  async function addAmbulance(e) {
    e.preventDefault();
    if (!ambulanceCode.trim()) return;
    setBusy(true); setError("");
    try {
      await apiRequest("/admin/ambulances", {
        token: session.token,
        method: "POST",
        body: JSON.stringify({ code: ambulanceCode.trim() }),
      });
      setAmbulanceCode("");
      await loadAll();
    } catch (e) {
      setError(e.message || "Could not add ambulance.");
    } finally { setBusy(false); }
  }

  if (session.role !== "ADMIN") {
    return (
      <Section title="Administrator access required">
        <div className="text-sm text-rose-600">This page is restricted to System Administrators.</div>
      </Section>
    );
  }

  const totals = reports?.totals || {};
  const timing = reports?.timing || {};
  const destinations = reports?.byDestination || [];

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">System Administration</h1>
          <p className="text-sm text-slate-500">Full operational visibility and configuration.</p>
        </div>
        <button onClick={loadAll} disabled={loading || busy} className="px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm font-medium flex items-center gap-2">
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-800 p-3 text-sm">
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-b border-slate-200">
        {[
          ["overview", "Overview"],
          ["cases", `All Cases (${cases.length})`],
          ["users", `Users (${users.length})`],
          ["resources", "Facilities & Ambulances"],
        ].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-2 text-sm font-medium ${tab === k ? "text-[#0B3D5C] border-b-2 border-[#0B3D5C]" : "text-slate-500"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Total cases" value={totals.total ?? cases.length} />
            <StatCard label="Emergency" value={totals.emergency ?? 0} tone="rose" />
            <StatCard label="Completed" value={totals.completed ?? 0} tone="emerald" />
            <StatCard label="Ambulances dispatched" value={totals.ambulances_dispatched ?? 0} />
            <StatCard label="Trauma" value={totals.trauma ?? 0} />
            <StatCard label="Suspected stroke" value={totals.stroke ?? 0} />
            <StatCard label="Suspected MI" value={totals.mi ?? 0} />
            <StatCard label="Active users" value={users.filter(u => u.active).length} />
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <Section title="Response-time metrics">
              <div className="space-y-2 text-sm">
                <Metric label="Dispatch → scene" value={secondsToMinutes(timing.avg_dispatch_to_scene_sec)} />
                <Metric label="Scene → hospital" value={secondsToMinutes(timing.avg_scene_to_hospital_sec)} />
                <Metric label="Dispatch → hospital" value={secondsToMinutes(timing.avg_total_response_sec)} />
                <Metric label="Hospital → handover" value={secondsToMinutes(timing.avg_handover_sec)} />
              </div>
            </Section>
            <Section title="Cases by destination">
              {destinations.length ? destinations.map(d => (
                <div key={d.facility} className="flex justify-between py-1 text-sm border-b border-slate-50">
                  <span>{d.facility || "Not recorded"}</span><strong>{d.n}</strong>
                </div>
              )) : <div className="text-sm text-slate-400">No destination data.</div>}
            </Section>
          </div>
        </div>
      )}

      {tab === "cases" && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <CaseTable cases={cases} loading={loading} onOpenCase={onOpenCase} />
        </div>
      )}

      {tab === "users" && (
        <div className="grid lg:grid-cols-[1fr_1.5fr] gap-4">
          <Section title="Create user">
            <form onSubmit={createUser} className="space-y-3">
              <input className="ems-login-input" placeholder="Full name" value={userForm.name}
                onChange={e => setUserForm({...userForm, name: e.target.value})} />
              <input className="ems-login-input" placeholder="Phone number" value={userForm.phone}
                onChange={e => setUserForm({...userForm, phone: e.target.value})} />
              <select className="ems-login-input" value={userForm.role}
                onChange={e => setUserForm({...userForm, role: e.target.value})}>
                <option value="ADMIN">Admin</option>
                <option value="METRO">Metro</option>
                <option value="PARAMEDIC">Paramedic</option>
                <option value="DOCTOR">Doctor</option>
              </select>
              <input className="ems-login-input" type="password" placeholder="Temporary password"
                value={userForm.password} onChange={e => setUserForm({...userForm, password: e.target.value})} />
              <button disabled={busy} className="w-full px-3 py-2 rounded-lg bg-[#0B3D5C] text-white font-semibold">
                {busy ? "Saving…" : "Create user"}
              </button>
            </form>
          </Section>
          <Section title="User directory">
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-slate-500 border-b">
                  <th className="py-2">Name</th><th>Phone</th><th>Role</th><th>Status</th><th></th>
                </tr></thead>
                <tbody>{users.map(u => (
                  <tr key={u.id} className="border-b border-slate-50">
                    <td className="py-2">{u.name}</td><td>{u.phone}</td><td>{u.role}</td>
                    <td>{u.active ? "Active" : "Disabled"}</td>
                    <td className="text-right">
                      <button onClick={() => toggleUser(u)} disabled={busy || u.id === session.id}
                        className="text-xs px-2 py-1 rounded border border-slate-200">
                        {u.active ? "Disable" : "Enable"}
                      </button>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </Section>
        </div>
      )}

      {tab === "resources" && (
        <div className="grid md:grid-cols-2 gap-4">
          <Section title="Facilities">
            <form onSubmit={addFacility} className="flex gap-2 mb-3">
              <input className="ems-login-input flex-1" placeholder="Facility name" value={facilityName} onChange={e => setFacilityName(e.target.value)} />
              <button disabled={busy} className="px-3 rounded-lg bg-[#0B3D5C] text-white"><Plus size={18}/></button>
            </form>
            <div className="space-y-1 text-sm">
              {facilities.map(f => <div key={f.id} className="flex justify-between border-b border-slate-50 py-2"><span>{f.name}</span><span className="text-xs text-slate-400">{f.active ? "Active" : "Inactive"}</span></div>)}
            </div>
          </Section>
          <Section title="Ambulances">
            <form onSubmit={addAmbulance} className="flex gap-2 mb-3">
              <input className="ems-login-input flex-1" placeholder="Code, e.g. LMC Ambulance 4" value={ambulanceCode} onChange={e => setAmbulanceCode(e.target.value)} />
              <button disabled={busy} className="px-3 rounded-lg bg-[#0B3D5C] text-white"><Plus size={18}/></button>
            </form>
            <div className="space-y-1 text-sm">
              {ambulances.map(a => <div key={a.id} className="flex justify-between border-b border-slate-50 py-2"><span>{a.code}</span><span className="text-xs text-slate-400">{a.active ? "Active" : "Inactive"}</span></div>)}
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}

function secondsToMinutes(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const seconds = Number(value);
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m ${rem}s`;
}

function Metric({ label, value }) {
  return <div className="flex justify-between border-b border-slate-50 py-1"><span>{label}</span><strong>{value}</strong></div>;
}
