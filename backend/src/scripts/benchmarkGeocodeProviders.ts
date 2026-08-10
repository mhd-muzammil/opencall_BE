// The Phase 2 gate: run the SAME real addresses through every configured
// provider and report the hit rate PER BRANCH.
//
// WHY PER BRANCH AND NOT AN AVERAGE
// ---------------------------------
// Geoapify and OpenCage are OpenStreetMap-derived, and OSM's semi-urban Tamil
// Nadu coverage is thinner than the proprietary Indian datasets. Salem, Hosur
// and Vellore are 3 of the 5 branches and 1,755 of 3,242 work orders. A provider
// that scores 90% in Chennai and 40% in Hosur would pass a global average while
// being useless for more than half the business, so the average is not reported
// as the verdict — the worst branch is.
//
// THE PASS MARK
// -------------
// >= 75% rooftop-or-street, per branch. Below that the geocoding tier is not
// meaningfully better than the pincode centroid it replaces, and the honest
// outcome is to stop at Phase 1 rather than add a dependency for nothing.
//
// Costs real provider calls (default 200 per provider, ~8% of OpenCage's daily
// free tier). Writes NOTHING to the database — it never touches geocode_cache,
// so it cannot pollute the real cache with benchmark traffic.
//
//   npx tsx src/scripts/benchmarkGeocodeProviders.ts [sampleSize]
//   node dist/scripts/benchmarkGeocodeProviders.js [sampleSize]
import { closeDatabasePool, query } from "../config/database.js";
import { buildGeocodableAddress } from "../services/geo/geocodeAddress.js";
import { resolveAllConfiguredProviders } from "../services/geo/providerRegistry.js";
import { haversineKm } from "../utils/geo.js";
import type { GeocodeProvider, GeocodeResult } from "../services/geo/geocodeTypes.js";

const DEFAULT_SAMPLE_SIZE = 200;
const PASS_MARK_PERCENT = 75;
const REQUEST_TIMEOUT_MS = 15_000;

const BRANCH_LABELS: Record<string, string> = {
  ASPS01461: "Chennai",
  ASPS01463: "Vellore",
  ASPS01465: "Salem",
  ASPS01489: "Kanchipuram",
  ASPS01511: "Hosur",
};

interface SampleRow {
  normalized_ticket_id: string;
  work_location: string | null;
  customer_address: string | null;
  common_address: string | null;
  customer_city: string | null;
  customer_state: string | null;
  customer_pincode: string | null;
}

interface Sample {
  ticketId: string;
  branch: string;
  addressText: string;
}

interface Outcome {
  precision: "rooftop" | "street" | "locality" | "none" | "error";
  latitude: number | null;
  longitude: number | null;
  locality: string | null;
}

function percent(part: number, total: number): string {
  return total === 0 ? "  n/a" : `${((100 * part) / total).toFixed(1).padStart(5)}%`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A stratified sample: proportional across branches rather than whatever the
 * newest rows happen to be. Benchmarking 200 Chennai addresses would answer the
 * wrong question entirely.
 */
async function loadSample(sampleSize: number): Promise<Sample[]> {
  const result = await query<SampleRow>(
    `
      WITH latest AS (
        SELECT DISTINCT ON (f.normalized_ticket_id)
               f.normalized_ticket_id,
               f.work_location,
               COALESCE(f.customer_address, f.raw_row->>'Customer Address') AS customer_address,
               COALESCE(f.common_address,   f.raw_row->>'Common Address')   AS common_address,
               COALESCE(f.customer_city,    f.raw_row->>'Customer City')    AS customer_city,
               COALESCE(f.customer_state,   f.raw_row->>'Customer State')   AS customer_state,
               COALESCE(f.customer_pincode, f.raw_row->>'Customer Pincode') AS customer_pincode
          FROM flex_wip_records f
         WHERE f.normalized_ticket_id IS NOT NULL AND f.normalized_ticket_id <> ''
         ORDER BY f.normalized_ticket_id, f.created_at DESC
      ),
      ranked AS (
        SELECT latest.*,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(NULLIF(TRIM(work_location), ''), 'UNKNOWN')
                 -- Deterministic but arbitrary: hashing the ticket id spreads the
                 -- sample across the branch instead of taking one contiguous run.
                 ORDER BY md5(normalized_ticket_id)
               ) AS rank_in_branch,
               COUNT(*) OVER (
                 PARTITION BY COALESCE(NULLIF(TRIM(work_location), ''), 'UNKNOWN')
               ) AS branch_total,
               COUNT(*) OVER () AS grand_total
          FROM latest
      )
      SELECT normalized_ticket_id, work_location, customer_address, common_address,
             customer_city, customer_state, customer_pincode
        FROM ranked
       WHERE rank_in_branch <= GREATEST(1, CEIL($1::numeric * branch_total / grand_total))
       ORDER BY work_location, rank_in_branch
    `,
    [sampleSize],
  );

  const samples: Sample[] = [];
  for (const row of result.rows) {
    const built = buildGeocodableAddress({
      customerAddress: row.customer_address,
      commonAddress: row.common_address,
      customerCity: row.customer_city,
      customerState: row.customer_state,
      customerPincode: row.customer_pincode,
    });

    // No geocodable address means the pincode tier answers alone — not a
    // provider's failure, so excluded rather than counted against them.
    if (!built) {
      continue;
    }

    const code = (row.work_location ?? "").trim().toUpperCase();
    samples.push({
      ticketId: row.normalized_ticket_id,
      branch: BRANCH_LABELS[code] ?? code ?? "UNKNOWN",
      addressText: built.text,
    });
  }

  return samples;
}

async function runProvider(
  provider: GeocodeProvider,
  samples: readonly Sample[],
): Promise<Map<string, Outcome>> {
  const outcomes = new Map<string, Outcome>();
  const spacingMs = Math.max(provider.minRequestSpacingMs ?? 0, 200);

  let done = 0;
  for (const sample of samples) {
    let result: GeocodeResult | null = null;
    let errored = false;

    try {
      result = await provider.geocode(
        sample.addressText,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      );
    } catch (error) {
      errored = true;
      // Logged rather than swallowed: a benchmark that silently counts quota
      // errors as misses would condemn a perfectly good provider.
      console.error(
        `  [${provider.name}] ERROR on ${sample.ticketId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    outcomes.set(sample.ticketId, {
      precision: errored ? "error" : (result?.precision ?? "none"),
      latitude: result?.latitude ?? null,
      longitude: result?.longitude ?? null,
      locality: result?.locality ?? null,
    });

    done += 1;
    if (done % 25 === 0) {
      console.log(`  [${provider.name}] ${done}/${samples.length}`);
    }
    await sleep(spacingMs);
  }

  return outcomes;
}

function reportProvider(
  provider: GeocodeProvider,
  samples: readonly Sample[],
  outcomes: Map<string, Outcome>,
): void {
  const branches = [...new Set(samples.map((sample) => sample.branch))].sort();

  console.log(`\n--- ${provider.name} ---`);
  console.log(
    "  branch          n   rooftop    street  locality      none     error   USABLE  verdict",
  );

  let worstUsable = 101;
  let worstBranch = "";

  for (const branch of [...branches, "ALL"]) {
    const rows = branch === "ALL" ? samples : samples.filter((s) => s.branch === branch);
    const counts = { rooftop: 0, street: 0, locality: 0, none: 0, error: 0 };

    for (const sample of rows) {
      const outcome = outcomes.get(sample.ticketId);
      if (outcome) {
        counts[outcome.precision] += 1;
      }
    }

    // Errors are excluded from the denominator: a quota failure is a fact about
    // the run, not about the provider's data quality.
    const scored = rows.length - counts.error;
    const usable = counts.rooftop + counts.street;
    const usablePct = scored === 0 ? 0 : (100 * usable) / scored;

    if (branch !== "ALL" && scored > 0 && usablePct < worstUsable) {
      worstUsable = usablePct;
      worstBranch = branch;
    }

    const verdict =
      branch === "ALL"
        ? ""
        : scored === 0
          ? "  no data"
          : usablePct >= PASS_MARK_PERCENT
            ? "  PASS"
            : "  FAIL";

    console.log(
      `  ${branch.padEnd(12)} ${String(rows.length).padStart(4)}   ` +
        `${percent(counts.rooftop, scored)}    ${percent(counts.street, scored)}    ` +
        `${percent(counts.locality, scored)}    ${percent(counts.none, scored)}    ` +
        `${String(counts.error).padStart(5)}   ${percent(usable, scored)}${verdict}`,
    );
  }

  const localityCount = [...outcomes.values()].filter((o) => o.locality !== null).length;
  console.log(
    `  locality name returned on ${localityCount}/${samples.length} ` +
      `(${((100 * localityCount) / Math.max(samples.length, 1)).toFixed(1)}%) — this is what the Location column becomes`,
  );

  if (worstBranch) {
    const passes = worstUsable >= PASS_MARK_PERCENT;
    console.log(
      `  WORST BRANCH: ${worstBranch} at ${worstUsable.toFixed(1)}% — ` +
        `${passes ? "clears" : "MISSES"} the ${PASS_MARK_PERCENT}% pass mark`,
    );
  }
}

/**
 * How far apart the providers put the same address.
 *
 * Two vendors agreeing to within a few hundred metres is strong evidence both
 * are right. A systematic kilometres-apart disagreement means at least one is
 * wrong, and the hit-rate table alone would never reveal it.
 */
function reportDisagreement(
  samples: readonly Sample[],
  byProvider: Map<string, Map<string, Outcome>>,
): void {
  const names = [...byProvider.keys()];
  if (names.length < 2) {
    return;
  }

  console.log("\n=== CROSS-PROVIDER AGREEMENT ===");

  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = byProvider.get(names[i]!)!;
      const b = byProvider.get(names[j]!)!;
      const distances: number[] = [];

      for (const sample of samples) {
        const left = a.get(sample.ticketId);
        const right = b.get(sample.ticketId);
        if (left?.latitude == null || right?.latitude == null) {
          continue;
        }
        distances.push(
          haversineKm(
            { latitude: left.latitude, longitude: left.longitude! },
            { latitude: right.latitude, longitude: right.longitude! },
          ),
        );
      }

      if (distances.length === 0) {
        continue;
      }

      distances.sort((x, y) => x - y);
      const median = distances[Math.floor(distances.length / 2)]!;
      const p90 = distances[Math.floor(distances.length * 0.9)]!;
      const within500m = distances.filter((d) => d <= 0.5).length;

      console.log(
        `  ${names[i]} vs ${names[j]}: n=${distances.length}  ` +
          `median ${median.toFixed(2)}km  p90 ${p90.toFixed(2)}km  ` +
          `agree within 500m: ${((100 * within500m) / distances.length).toFixed(1)}%`,
      );
    }
  }
}

async function run(): Promise<void> {
  const sampleSize = Number(process.argv[2] ?? DEFAULT_SAMPLE_SIZE);
  const providers = resolveAllConfiguredProviders();

  if (providers.length === 0) {
    console.error(
      "No providers configured. Set at least one of GEOAPIFY_API_KEY, OPENCAGE_API_KEY, " +
        "OLA_MAPS_API_KEY and re-run.\n" +
        "This script builds every provider that has a key, regardless of GEOCODE_PROVIDER.",
    );
    process.exitCode = 1;
    return;
  }

  const samples = await loadSample(sampleSize);
  if (samples.length === 0) {
    console.error("No geocodable addresses found. Has an upload run?");
    process.exitCode = 1;
    return;
  }

  console.log("=== GEOCODE PROVIDER BAKE-OFF ===\n");
  console.log(`sample     : ${samples.length} work orders (stratified by branch)`);
  console.log(`providers  : ${providers.map((p) => p.name).join(", ")}`);
  console.log(`pass mark  : ${PASS_MARK_PERCENT}% rooftop-or-street, PER BRANCH`);
  console.log(`total calls: ~${samples.length * providers.length}\n`);

  const byProvider = new Map<string, Map<string, Outcome>>();
  for (const provider of providers) {
    console.log(`Running ${provider.name}...`);
    byProvider.set(provider.name, await runProvider(provider, samples));
  }

  console.log("\n=== RESULTS ===");
  for (const provider of providers) {
    reportProvider(provider, samples, byProvider.get(provider.name)!);
  }

  reportDisagreement(samples, byProvider);

  console.log(
    "\nPick the provider whose WORST branch clears the pass mark. If none does, " +
      "stopping at Phase 1 (pincode centroids) is the honest outcome — it costs nothing " +
      "and adds no dependency.",
  );
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
