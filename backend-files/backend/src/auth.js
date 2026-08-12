const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET must be set (see .env.example) — refusing to start with an insecure default.");
}
const JWT_EXPIRY = "12h"; // one shift; re-login required after, per §16 access-control expectations

function signToken(user) {
  return jwt.sign(
    { sub: user.id, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function hashPassword(pw) {
  return bcrypt.hashSync(pw, 12);
}
function verifyPassword(pw, hash) {
  return bcrypt.compareSync(pw, hash);
}

/** Express middleware: requires a valid bearer token, attaches req.user. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing bearer token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, name: payload.name, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/** Express middleware factory: requires req.user.role to be one of `roles`.
 *  Call AFTER requireAuth. All server-side authorization decisions live
 *  here — the frontend's role-based UI is a convenience, not a security
 *  boundary; every mutating route re-checks role on the server (§16, §24). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(" or ")}` });
    }
    next();
  };
}

module.exports = { signToken, hashPassword, verifyPassword, requireAuth, requireRole };
