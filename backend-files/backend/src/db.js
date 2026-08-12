const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render/Railway/RDS etc. usually need SSL; disable locally via PGSSL=false
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  // A backend serving live ambulances must not crash on a dropped idle
  // connection — log and let the pool reconnect on next query.
  console.error("[db] unexpected idle client error", err);
});

module.exports = { pool };
