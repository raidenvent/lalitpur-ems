const { pool } = require("./db");

/**
 * Atomically allocate the next EncID for the current year.
 * Uses SELECT ... FOR UPDATE inside the caller's transaction so two Metro
 * operators creating cases at the same instant never collide, even under
 * concurrent load — this is why EncID generation must happen server-side
 * and never be computed client-side from a locally cached case count.
 */
async function nextEncId(client) {
  const year = new Date().getFullYear();
  await client.query(
    `INSERT INTO enc_id_sequences (year, next_n) VALUES ($1, 1)
     ON CONFLICT (year) DO NOTHING`,
    [year]
  );
  const { rows } = await client.query(
    `UPDATE enc_id_sequences SET next_n = next_n + 1
     WHERE year = $1 RETURNING next_n - 1 AS n`,
    [year]
  );
  const n = rows[0].n;
  return `LMC-${year}-${String(n).padStart(6, "0")}`;
}

module.exports = { nextEncId };
