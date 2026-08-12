/**
 * One-off setup script: applies schema.sql, then creates a starter user
 * for each role so you can log in immediately.
 * Run:  node src/seed.js
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { pool } = require("./db");
const { hashPassword } = require("./auth");

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  console.log("Applying schema.sql ...");
  await pool.query(schema);

  const users = [
    { name: "Admin User", phone: "9800000001", role: "ADMIN", password: "ChangeMe!Admin1" },
    { name: "Metro Operator", phone: "9800000002", role: "METRO", password: "ChangeMe!Metro1" },
    { name: "Paramedic One", phone: "9800000003", role: "PARAMEDIC", password: "ChangeMe!Para1" },
    { name: "Doctor Reception", phone: "9800000004", role: "DOCTOR", password: "ChangeMe!Doc1" },
  ];

  for (const u of users) {
    await pool.query(
      `INSERT INTO users (name, phone, role, password_hash) VALUES ($1,$2,$3,$4)
       ON CONFLICT (phone) DO NOTHING`,
      [u.name, u.phone, u.role, hashPassword(u.password)]
    );
    console.log(`Seeded ${u.role} — phone: ${u.phone} / password: ${u.password}`);
  }

  console.log("\nDone. CHANGE THESE PASSWORDS before any real use.");
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
