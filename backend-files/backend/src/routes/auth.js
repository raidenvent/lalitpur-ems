const express = require("express");
const { pool } = require("../db");
const { signToken, verifyPassword } = require("../auth");

const router = express.Router();

// POST /api/auth/login  { phone, password }
router.post("/login", async (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: "phone and password required" });

  const { rows } = await pool.query(
    `SELECT * FROM users WHERE phone = $1 AND active = TRUE`,
    [phone]
  );
  const user = rows[0];
  // Constant-shape response whether or not the user exists, to avoid
  // leaking which phone numbers are registered.
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = signToken(user);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

module.exports = router;
