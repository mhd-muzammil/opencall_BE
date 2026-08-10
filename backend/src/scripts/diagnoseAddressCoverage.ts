// Address coverage across ALL persisted Flex WIP records — the Phase 0 output.
//
// WHY THIS EXISTS
// ---------------
// Every number behind the geocoding plan was measured on a single export
// (626 rows). That is enough to design against and not enough to commit money
// or a provider contract to. This reports the same figures over the whole
// production history, so the Phase 2 provider decision rests on the real
// distribution rather than on one Tuesday's file.
//
// It also answers the question that decides the cost: how many DISTINCT
// addresses are there? Geocoding is cached per address, so distinct-address
// count is the bill, not row count.
//
// Read-only. Safe to run against production at any time.
//
//   npx tsx src/scripts/diagnoseAddressCoverage.ts        (dev)
//   node dist/scripts/diagnoseAddressCoverage.js          (prod)
import { closeDatabasePool, pool } from "../config/database.js";
import {
  buildGeocodeQuery,
  selectAddress,
  type AddressSource,
} from "../services/geo/addressSelector.js";

interface AddressRow {
  normalized_ticket_id: string;
  customer_address: string | null;
  common_address: string | null;
  customer_city: string | null;
  customer_state: string | null;
  customer_pincode: string | null;
  work_location: string | null;
}

function percent(part: number, total: number): string {
  return total === 0 ? "0.0%" : `${((100 * part) / total).toFixed(1)}%`;
}

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    // One row per ticket: the same work order repeats per part line, and
    // counting those would inflate every figure. DISTINCT ON needs the ticket
    // as the leading ORDER BY key.
    const result = await client.query<AddressRow>(
      `
        SELECT DISTINCT ON (normalized_ticket_id)
          normalized_ticket_id,
          customer_address,
          common_address,
          customer_city,
          customer_state,
          customer_pincode,
          work_location
        FROM flex_wip_records
        ORDER BY normalized_ticket_id, created_at DESC
      `,
    );

    const rows = result.rows;
    const total = rows.length;

    if (total === 0) {
      console.log("No flex_wip_records found. Has an upload run yet?");
      return;
    }

    const bySource: Record<AddressSource, number> = { customer: 0, common: 0, none: 0 };
    const byRegion = new Map<string, { total: number; usable: number }>();
    const distinctQueries = new Set<string>();

    let rawCustomer = 0;
    let rawCommon = 0;
    let bothPresent = 0;
    let identical = 0;
    let validPincode = 0;
    let truncationAvoided = 0;
    let prefixResolved = 0;

    for (const row of rows) {
      const fields = {
        customerAddress: row.customer_address,
        commonAddress: row.common_address,
        customerCity: row.customer_city,
        customerState: row.customer_state,
        customerPincode: row.customer_pincode,
      };

      if (row.customer_address) rawCustomer += 1;
      if (row.common_address) rawCommon += 1;
      if (row.customer_address && row.common_address) {
        bothPresent += 1;
        if (row.customer_address.trim().toLowerCase() === row.common_address.trim().toLowerCase()) {
          identical += 1;
        }
      }

      const selected = selectAddress(fields);
      bySource[selected.source] += 1;
      if (selected.pincode) validPincode += 1;
      if (selected.reason.prefixRelation) prefixResolved += 1;
      if (
        selected.source === "common" &&
        selected.reason.customerTruncated &&
        !selected.reason.commonTruncated
      ) {
        truncationAvoided += 1;
      }

      const query = buildGeocodeQuery(fields);
      if (query) {
        // Case-folded: the provider call is the same either way, so counting
        // both spellings would overstate the bill.
        distinctQueries.add(query.toLowerCase());
      }

      const region = (row.work_location ?? "").trim().toUpperCase() || "UNKNOWN";
      const entry = byRegion.get(region) ?? { total: 0, usable: 0 };
      entry.total += 1;
      if (selected.source !== "none") entry.usable += 1;
      byRegion.set(region, entry);
    }

    const usable = total - bySource.none;

    console.log("=== ADDRESS COVERAGE (all persisted Flex WIP work orders) ===\n");
    console.log(`work orders                : ${total}`);
    console.log(`  Customer Address present : ${rawCustomer} (${percent(rawCustomer, total)})`);
    console.log(`  Common Address present   : ${rawCommon} (${percent(rawCommon, total)})`);
    console.log(`  both present             : ${bothPresent}  (identical on ${identical})`);
    console.log(`  valid 6-digit pincode    : ${validPincode} (${percent(validPincode, total)})\n`);

    console.log("--- selector outcome ---");
    console.log(`  chose Customer Address   : ${bySource.customer} (${percent(bySource.customer, total)})`);
    console.log(`  chose Common Address     : ${bySource.common} (${percent(bySource.common, total)})`);
    console.log(`  no usable address        : ${bySource.none} (${percent(bySource.none, total)})`);
    console.log(`  USABLE                   : ${usable} (${percent(usable, total)})`);
    console.log(`  truncated Customer Addr avoided : ${truncationAvoided}`);
    console.log(`  prefix pairs resolved           : ${prefixResolved}\n`);

    console.log("--- geocoding cost (this is the bill) ---");
    console.log(`  distinct addresses to geocode : ${distinctQueries.size}`);
    console.log(
      `  reuse factor                  : ${(usable / Math.max(distinctQueries.size, 1)).toFixed(2)}x ` +
        `(work orders per distinct address)`,
    );
    console.log(
      `  Ola free tier is 500,000/month — this backfill is ` +
        `${percent(distinctQueries.size, 500_000)} of one month's allowance\n`,
    );

    console.log("--- by branch ---");
    for (const [region, entry] of [...byRegion.entries()].sort((a, b) => b[1].total - a[1].total)) {
      console.log(
        `  ${region.padEnd(12)} ${String(entry.total).padStart(6)} work orders   ` +
          `usable ${percent(entry.usable, entry.total).padStart(6)}`,
      );
    }

    if (bySource.none > 0) {
      console.log(
        `\n${bySource.none} work orders have no usable address and will fall back to the ` +
          `pincode tier. That is the honest floor, not a bug.`,
      );
    }
  } finally {
    client.release();
  }
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
