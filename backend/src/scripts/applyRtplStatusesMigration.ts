import { closeDatabasePool, pool } from "../config/database.js";

const sqlQueries = [
  `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'RTPL_STATUS_CREATED';`,
  `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'RTPL_STATUS_UPDATED';`,
  `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'RTPL_STATUS_DELETED';`,

  `CREATE TABLE IF NOT EXISTS rtpl_statuses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR NOT NULL UNIQUE,
      category VARCHAR NOT NULL DEFAULT 'Other',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      created_by UUID REFERENCES users(id),
      updated_by UUID REFERENCES users(id),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  );`,

  `CREATE INDEX IF NOT EXISTS idx_rtpl_statuses_category ON rtpl_statuses(category);`,
  `CREATE INDEX IF NOT EXISTS idx_rtpl_statuses_is_active ON rtpl_statuses(is_active);`,

  `INSERT INTO rtpl_statuses (name, category, sort_order) VALUES
      ('Actionable', 'General Activity', 100),
      ('CX Pending', 'General Activity', 101),
      ('Problem Resolution', 'General Activity', 102),
      ('work in progress', 'General Activity', 103),
      ('under observation', 'General Activity', 104),
      ('To be Scheduled', 'Scheduling & Engineer', 200),
      ('Engg Assignment Pending', 'Scheduling & Engineer', 201),
      ('Engg Assigned', 'Scheduling & Engineer', 202),
      ('Part Order Pending', 'Parts & Inventory', 300),
      ('Additional Part', 'Parts & Inventory', 301),
      ('Good Part Received', 'Parts & Inventory', 302),
      ('SSC Pending → Part Pending', 'Parts & Inventory', 303),
      ('Part Quotation Pending', 'Quotations & Payments', 400),
      ('Part Quote Shared', 'Quotations & Payments', 401),
      ('Part Payment Received', 'Quotations & Payments', 402),
      ('Visit Estimate', 'Visitation & Estimates', 500),
      ('Visit Quote to Customer', 'Visitation & Estimates', 501),
      ('Visitation Accepted', 'Visitation & Estimates', 502),
      ('Visitation Rejected', 'Visitation & Estimates', 503),
      ('Need to Cancel', 'Cancellations & Closures', 600),
      ('Need to Cancel Mail', 'Cancellations & Closures', 601),
      ('Need to Close', 'Cancellations & Closures', 602),
      ('OTP', 'Cancellations & Closures', 603),
      ('WO-closed', 'Cancellations & Closures', 604),
      ('Closed-cancellation', 'Cancellations & Closures', 605),
      ('Need to Yank', 'Returns & Yank', 700),
      ('Yank', 'Returns & Yank', 701),
      ('Elevation HP Pending', 'Elevations / Escalations', 800),
      ('Elevation Part Pending', 'Elevations / Escalations', 801),
      ('CRT Pending', 'Validation & Testing', 900),
      ('CT Validation Pending', 'Validation & Testing', 901)
   ON CONFLICT (name) DO NOTHING;`,
];

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 020_rtpl_statuses.sql");
  } catch (error) {
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
