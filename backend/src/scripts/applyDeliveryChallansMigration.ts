import { closeDatabasePool, pool } from "../config/database.js";

// Migration 070_delivery_challans.sql — Delivery Challan (Warranty Replacement): the five
// branch letterheads, a per-branch per-financial-year running number, the challans and
// their goods rows. Inlined because the deploy image does not ship the repo's infra/
// directory. Every statement is guarded, so re-running is a no-op.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS challan_branches (
      branch_key     TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      company_line   TEXT NOT NULL DEFAULT '',
      address_lines  TEXT NOT NULL DEFAULT '',
      gstin          TEXT NOT NULL DEFAULT '',
      contact        TEXT NOT NULL DEFAULT '',
      email          TEXT NOT NULL DEFAULT '',
      updated_at     TIMESTAMPTZ,
      updated_by     TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS challan_sequences (
      branch_key  TEXT NOT NULL,
      fin_year    TEXT NOT NULL,
      last_seq    INTEGER NOT NULL,
      PRIMARY KEY (branch_key, fin_year)
  );`,
  `CREATE TABLE IF NOT EXISTS delivery_challans (
      id                BIGSERIAL PRIMARY KEY,
      branch_key        TEXT NOT NULL REFERENCES challan_branches (branch_key),
      fin_year          TEXT NOT NULL,
      dc_seq            INTEGER NOT NULL,
      challan_date      DATE NOT NULL,
      branch_header     JSONB NOT NULL,
      customer_name     TEXT NOT NULL DEFAULT '',
      customer_phone    TEXT NOT NULL DEFAULT '',
      customer_email    TEXT NOT NULL DEFAULT '',
      customer_address  TEXT NOT NULL DEFAULT '',
      case_ids          TEXT NOT NULL DEFAULT '',
      product_serials   TEXT NOT NULL DEFAULT '',
      product_numbers   TEXT NOT NULL DEFAULT '',
      product_names     TEXT NOT NULL DEFAULT '',
      ref_no_date       TEXT NOT NULL DEFAULT '',
      mode_terms        TEXT NOT NULL DEFAULT '',
      other_references  TEXT NOT NULL DEFAULT '',
      created_by        TEXT NOT NULL DEFAULT '',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by        TEXT,
      updated_at        TIMESTAMPTZ,
      UNIQUE (branch_key, fin_year, dc_seq)
  );`,
  `CREATE INDEX IF NOT EXISTS delivery_challans_created_at_idx
      ON delivery_challans (created_at DESC);`,
  `CREATE TABLE IF NOT EXISTS delivery_challan_items (
      id           BIGSERIAL PRIMARY KEY,
      challan_id   BIGINT NOT NULL REFERENCES delivery_challans (id) ON DELETE CASCADE,
      position     INTEGER NOT NULL DEFAULT 0,
      description  TEXT NOT NULL DEFAULT '',
      hsn_sac      TEXT NOT NULL DEFAULT '',
      qty          TEXT NOT NULL DEFAULT '',
      rate         TEXT NOT NULL DEFAULT '',
      per          TEXT NOT NULL DEFAULT ''
  );`,
  `CREATE INDEX IF NOT EXISTS delivery_challan_items_challan_idx
      ON delivery_challan_items (challan_id, position);`,
];

// The five branches. Hosur is the owner's sample sheet, word for word; Chennai is the
// office the quotations print (QUOTATION_COMPANY in the web app); Vellore, Salem and
// Kanchipuram carry only their names until the owner fills them in. Same text as the
// INSERT in 070_delivery_challans.sql, passed as parameters so no escaping can bend it.
const BRANCH_SEEDS: readonly (readonly [string, string, string, string, string, string, string])[] = [
  [
    "chennai",
    "Chennai",
    "RENDERWAYS TECHNOLOGY PVT LTD",
    "# 25, First Floor, Gandhi Street, Mettukuppam\nMaduravoyal, Chennai - 600095\nTamil Nadu",
    "33AALCR1788A1ZG",
    "9543095480",
    "chennai@renderways.in",
  ],
  ["vellore", "Vellore", "", "", "", "", ""],
  ["salem", "Salem", "", "", "", "", ""],
  ["kanchipuram", "Kanchipuram", "", "", "", "", ""],
  [
    "hosur",
    "Hosur",
    "Renderways Technologies –",
    "L-88A, Rayakottai Hudco, Opp-Murugan Temple\nHosur – 635109",
    "33AALCR1788A1ZG",
    "+916383428751",
    "hosur@renderways.in",
  ],
];

// ON CONFLICT DO NOTHING: once a super admin has edited a branch, re-running this must
// not put the seeded text back.
const SEED_BRANCH_SQL = `INSERT INTO challan_branches
      (branch_key, name, company_line, address_lines, gstin, contact, email)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (branch_key) DO NOTHING`;

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    for (const seed of BRANCH_SEEDS) {
      await client.query(SEED_BRANCH_SQL, [...seed]);
    }
    await client.query("COMMIT");
    console.log("Applied migration 070_delivery_challans.sql");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* nothing open */
    }
    console.error("Migration failed:", error);
    throw error;
  } finally {
    client.release();
  }
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
