import { query as pgQuery } from "../config/database.js";
import { extractPartLine } from "./normalization/dedupeRowsByTicket.js";

export function mapAspCodeToRegion(workLocation: string | null | undefined): string {
  if (!workLocation) return "";
  const code = workLocation.trim().toUpperCase();
  if (code === "ASPS01461" || code.includes("CHENNAI")) return "chennai";
  if (code === "ASPS01463" || code.includes("VELLORE")) return "vellore";
  if (code === "ASPS01465" || code.includes("SALEM")) return "salem";
  if (code === "ASPS01489" || code.includes("KANCHIPURAM")) return "kanchipuram";
  if (code === "ASPS01511" || code.includes("HOSUR")) return "hosur";
  return "";
}

export interface SyncRowInput {
  case_id: string | null;
  ticket_id: string;
  part: string | null;
  work_location: string | null;
  engineer?: string | null;
  customer_name?: string | null;
}

// --- Per-part identity (a case can order several distinct parts) ---

export interface CasePartNumbers {
  goodPartNumber: string;
  partOrderNumber: string;
  soNumber: string;
}

/**
 * A part's identity within a case: its Part Order No, or its Good Part No when
 * the order number is blank. Case/space-insensitive. "" means the part carries
 * no identifying number at all.
 */
export function partIdentity(part: CasePartNumbers): string {
  return (part.partOrderNumber || part.goodPartNumber || "").trim().toLowerCase();
}

/**
 * Collapse a case's Flex part rows to one entry per distinct part. The Flex WIP
 * file has one row per part line, so a multi-part case yields several rows — but
 * the same part can repeat (re-uploaded, duplicate lines). Deduped on
 * {@link partIdentity}; at most one "unkeyed" (no numbers) part is kept so a
 * case never loses its single inventory row.
 */
export function dedupeCaseParts(parts: readonly CasePartNumbers[]): CasePartNumbers[] {
  const seen = new Set<string>();
  const out: CasePartNumbers[] = [];
  for (const part of parts) {
    const key = partIdentity(part) || "__unkeyed__";
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out;
}

/**
 * Does an existing inventory item represent this part? Matched by Part Order No;
 * a part with no order number matches an order-number-less item by Good Part No.
 * This is the (case_id + part) key the per-part upsert dedupes on.
 */
export function itemMatchesPart(
  item: { part_order_number?: string | null; good_part_number?: string | null },
  part: CasePartNumbers,
): boolean {
  const itemPo = (item.part_order_number ?? "").trim();
  const itemGp = (item.good_part_number ?? "").trim();
  const partPo = part.partOrderNumber.trim();
  const partGp = part.goodPartNumber.trim();
  if (partPo) return itemPo === partPo;
  if (partGp) return !itemPo && itemGp === partGp;
  return !itemPo && !itemGp;
}

const EMPTY_PART: CasePartNumbers = {
  goodPartNumber: "",
  partOrderNumber: "",
  soNumber: "",
};

/**
 * Every distinct part ordered against a case, from the LATEST Flex batch that
 * carries it (older batches may list stale parts). One inventory item is synced
 * per returned part. Never empty: a case whose parts carry no numbers still
 * yields exactly one (blank) item, preserving the pre-per-part behaviour.
 */
export async function fetchCaseParts(caseId: string): Promise<CasePartNumbers[]> {
  try {
    const result = await pgQuery<{ raw_row: Record<string, unknown> }>(
      `
        WITH latest AS (
          SELECT fw.upload_batch_id AS id
          FROM flex_wip_records fw
          JOIN source_upload_batches b ON b.id = fw.upload_batch_id
          WHERE fw.case_id = $1 OR fw.normalized_case_id = $1
          ORDER BY b.created_at DESC
          LIMIT 1
        )
        SELECT fw.raw_row
        FROM flex_wip_records fw
        WHERE fw.upload_batch_id IN (SELECT id FROM latest)
          AND (fw.case_id = $1 OR fw.normalized_case_id = $1)
      `,
      [caseId],
    );
    // extractPartLine handles the column-name variants ("Good Part No" vs
    // "Good Part Number", …) the same way the report generator does.
    const parts = dedupeCaseParts(
      result.rows.map((r) => {
        const line = extractPartLine({ rawRow: r.raw_row });
        return {
          goodPartNumber: line.goodPartNo ?? "",
          partOrderNumber: line.partOrderNo ?? "",
          soNumber: line.soNumber ?? "",
        };
      }),
    );
    return parts.length > 0 ? parts : [EMPTY_PART];
  } catch (e) {
    console.error("[InventorySync] parts lookup failed:", e);
    return [EMPTY_PART];
  }
}

// --- Inventory HTTP API client (prod-grade sync path) ---

let cachedInventoryToken: { access: string; expiresAt: number } | null = null;

function inventoryApiBase(): string {
  return (process.env.INVENTORY_API_URL || "").replace(/\/+$/, "");
}

async function getInventoryToken(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedInventoryToken &&
    cachedInventoryToken.expiresAt > now
  ) {
    return cachedInventoryToken.access;
  }

  const username = process.env.INVENTORY_API_USER;
  const password = process.env.INVENTORY_API_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "INVENTORY_API_USER and INVENTORY_API_PASSWORD must be set when INVENTORY_API_URL is configured",
    );
  }

  const res = await fetch(`${inventoryApiBase()}/auth/login/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new Error(
      `Inventory login failed (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as { access?: string };
  if (!data.access) {
    throw new Error("Inventory login response did not include an access token");
  }
  // simplejwt default access lifetime is 5 min; cache 4 min and re-login on 401.
  cachedInventoryToken = { access: data.access, expiresAt: now + 4 * 60 * 1000 };
  return data.access;
}

export function inventoryApiConfigured(): boolean {
  return Boolean(process.env.INVENTORY_API_URL);
}

export async function inventoryFetch(
  path: string,
  init: { method: string; body?: string },
  retryOn401 = true,
): Promise<Response> {
  const token = await getInventoryToken();
  const options: RequestInit = {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  };
  if (init.body !== undefined) {
    options.body = init.body;
  }
  const res = await fetch(`${inventoryApiBase()}${path}`, options);
  if (res.status === 401 && retryOn401) {
    await getInventoryToken(true); // token expired/rotated — force re-login
    return inventoryFetch(path, init, false);
  }
  return res;
}

async function syncCasePartsViaApi(
  row: SyncRowInput,
  detailsString: string,
  detailsObj: any,
  latestMeta: any,
  parts: readonly CasePartNumbers[],
): Promise<void> {
  const caseId = String(row.case_id);
  const mappedRegion = mapAspCodeToRegion(row.work_location);

  let caseCreatedIso: string | null = null;
  if (latestMeta?.case_created_time) {
    const parsed = new Date(latestMeta.case_created_time);
    if (!Number.isNaN(parsed.getTime())) {
      caseCreatedIso = parsed.toISOString();
    }
  }

  // 1. Look up ALL existing HP Stock items for this case (one per part). The
  //    service user must be an admin/super_admin/manager so this lookup is NOT
  //    region-scoped — otherwise dedup would miss items in other regions and
  //    create duplicates.
  const searchRes = await inventoryFetch(
    `/hp-stock/items/?search=${encodeURIComponent(caseId)}&per_page=100`,
    { method: "GET" },
  );
  if (!searchRes.ok) {
    throw new Error(
      `HP stock lookup failed (${searchRes.status}): ${await searchRes.text()}`,
    );
  }
  const searchData = (await searchRes.json()) as {
    items?: Array<Record<string, any>>;
  };
  const caseItems = (searchData.items || []).filter(
    (it) => String(it.case_id) === caseId,
  );

  // 2. Upsert one item per part, matching on (case_id + part). `claimed` stops a
  //    single existing item from being assigned to two parts.
  const claimed = new Set<unknown>();
  for (const part of parts) {
    const existing = caseItems.find(
      (it) => !claimed.has(it.id) && itemMatchesPart(it, part),
    );

    if (!existing) {
      // 2a. Create a new HP Stock item (status starts at PENDING / "Stock Entry").
      const body = {
        case_id: row.case_id,
        work_order_id: row.ticket_id,
        delivery_no: "",
        service_event_no: "",
        material_order_no: "",
        hp_sales_order_no: "",
        gvrma_no: "",
        region: mappedRegion,
        status: "PENDING",
        engineer_name: row.engineer ?? "",
        engineer_phone: "",
        part_description: row.part ?? "",
        customer_name: row.customer_name ?? "",
        good_part_number: part.goodPartNumber,
        part_order_number: part.partOrderNumber,
        so_number: part.soNumber,
        inventory_details: detailsString,
        opencall_case_details: detailsObj,
        case_created_time: caseCreatedIso,
      };
      const res = await inventoryFetch(`/hp-stock/items/`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(
          `HP stock create failed (${res.status}): ${await res.text()}`,
        );
      }
      console.info(
        `[InventorySync] Created HPStockItem via API for case ${caseId} part ${part.partOrderNumber || part.goodPartNumber || "(none)"}`,
      );
      continue;
    }

    claimed.add(existing.id);
    // 2b. Refresh the latest-snapshot fields and fill blanks only. Never overwrite
    //     status or transition_history (transition_history is read-only in the API).
    const patch: Record<string, any> = {
      inventory_details: detailsString,
      opencall_case_details: detailsObj,
      case_created_time: caseCreatedIso,
    };
    if (!existing.work_order_id) patch.work_order_id = row.ticket_id;
    if (!existing.region) patch.region = mappedRegion;
    // Engineer name: keep inventory in sync with the latest OpenCall assignment.
    // Always push a non-blank name (so re-assignments propagate), but never blank
    // out an existing name if OpenCall has none. Phone is not sourced here, so it
    // is deliberately left untouched (the inventory OTP flow owns engineer_phone).
    const nextEngineer = (row.engineer ?? "").trim();
    if (nextEngineer && nextEngineer !== (existing.engineer_name ?? "")) {
      patch.engineer_name = nextEngineer;
    }
    if (!existing.part_description) patch.part_description = row.part ?? "";
    if (!existing.customer_name) patch.customer_name = row.customer_name ?? "";
    if (!existing.good_part_number && part.goodPartNumber)
      patch.good_part_number = part.goodPartNumber;
    if (!existing.part_order_number && part.partOrderNumber)
      patch.part_order_number = part.partOrderNumber;
    if (!existing.so_number && part.soNumber) patch.so_number = part.soNumber;

    const res = await inventoryFetch(`/hp-stock/items/${existing.id}/`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      throw new Error(
        `HP stock update failed (${res.status}): ${await res.text()}`,
      );
    }
    console.info(
      `[InventorySync] Updated HPStockItem via API for case ${caseId} part ${part.partOrderNumber || part.goodPartNumber || "(none)"}`,
    );
  }
}

export async function syncPartToInventory(row: SyncRowInput): Promise<void> {
  if (!row.case_id || !row.part) {
    return;
  }

  const cleanPart = row.part.trim();
  if (
    !cleanPart ||
    ["n/a", "na", "none", "not applicable", "not available"].includes(
      cleanPart.toLowerCase(),
    )
  ) {
    return;
  }

  // 1. Compile case history and metadata from opencalls system PostgreSQL database
  let detailsString = "";
  let caseDetailsJson = "{}";
  let latestMeta: any = null;
  let detailsObj: any = {};
  try {
    const historyResult = await pgQuery<{
      effective_date: string | null;
      rtpl_status: string | null;
      flex_status: string | null;
      remarks: string | null;
      manual_notes: string | null;
      engineer: string | null;
    }>(
      `
        SELECT
          COALESCE(reports.report_date::TEXT, rows.created_at::TEXT) AS effective_date,
          rows.rtpl_status,
          rows.flex_status,
          rows.remarks,
          rows.manual_notes,
          rows.engineer
        FROM daily_call_plan_report_rows rows
        LEFT JOIN daily_call_plan_reports reports
          ON reports.id = rows.report_id
        WHERE rows.case_id = $1
        ORDER BY reports.report_date DESC, rows.created_at DESC
      `,
      [row.case_id]
    );

    detailsString = historyResult.rows
      .map((h) => {
        const dateStr = h.effective_date
          ? new Date(h.effective_date).toLocaleDateString("en-GB")
          : "N/A";
        const rtpl = h.rtpl_status || "N/A";
        const flex = h.flex_status || "N/A";
        const eng = h.engineer || "Unassigned";
        const rem = h.remarks || "None";
        const notes = h.manual_notes ? ` | Notes: ${h.manual_notes}` : "";
        return `[${dateStr}] RTPL: ${rtpl} | Flex: ${flex} | Eng: ${eng}\nRemarks: ${rem}${notes}`;
      })
      .join("\n\n");

    // Fetch the latest output columns and appearances
    const metaResult = await pgQuery<{
      ticket_id: string | null;
      case_id: string | null;
      customer_name: string | null;
      customer_mail: string | null;
      work_location: string | null;
      location: string | null;
      rtpl_status: string | null;
      flex_status: string | null;
      segment: string | null;
      wo_otc_code: string | null;
      product_line_name: string | null;
      case_created_time: string | null;
      flex_status_unchanged_days: number | null;
      status_aging: string | null;
      wip_aging: string | null;
      hp_owner_status: string | null;
      created_at: string;
    }>(
      `
        SELECT 
          ticket_id, case_id, customer_name, customer_mail, work_location, 
          location, rtpl_status, flex_status, segment, wo_otc_code, 
          product_line_name, case_created_time::TEXT AS case_created_time, 
          flex_status_unchanged_days, status_aging, wip_aging, hp_owner_status, 
          created_at::TEXT AS created_at
        FROM daily_call_plan_report_rows
        WHERE case_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [row.case_id]
    );

    const countResult = await pgQuery<{ count: string }>(
      `SELECT COUNT(*)::TEXT as count FROM daily_call_plan_report_rows WHERE case_id = $1`,
      [row.case_id]
    );

    latestMeta = metaResult.rows[0];
    const appearancesCount = Number(countResult.rows[0]?.count ?? "1");

    // Get number of manual actions count by looking at history entries where update was manual
    const actionsCountResult = await pgQuery<{ count: string }>(
      `
        SELECT COUNT(*)::TEXT as count 
        FROM daily_call_plan_report_rows 
        WHERE case_id = $1 AND updated_by IS NOT NULL
      `,
      [row.case_id]
    );
    const actionsCount = Number(actionsCountResult.rows[0]?.count ?? "0");

    // Construct the structured output dictionary mimicking CaseDetailDrawer
    const outputDict = latestMeta ? {
      "Ticket ID": latestMeta.ticket_id || "",
      "Case ID": latestMeta.case_id || "",
      "Customer Name": latestMeta.customer_name || "",
      "Customer Mail": latestMeta.customer_mail || "",
      "Work Location": latestMeta.work_location || "",
      "Location": latestMeta.location || "",
      "Region": latestMeta.work_location ? mapAspCodeToRegion(latestMeta.work_location) : "",
      "RTPL status": latestMeta.rtpl_status || "",
      "Flex Status": latestMeta.flex_status || "",
      "Segment": latestMeta.segment || "",
      "WO OTC Code": latestMeta.wo_otc_code || "",
      "Product Line": latestMeta.product_line_name || "",
      "Case Created": latestMeta.case_created_time || "",
      "WIP aging": latestMeta.wip_aging || "",
      "Status Aging": latestMeta.status_aging || "",
      "HP Owner Status": latestMeta.hp_owner_status || "",
    } : {};

    detailsObj = {
      output: outputDict,
      flex_status_unchanged_days: latestMeta?.flex_status_unchanged_days ?? null,
      status_aging: latestMeta?.status_aging ?? null,
      appearances: appearancesCount,
      actions_taken: actionsCount,
      created_at: latestMeta?.created_at ?? new Date().toISOString(),
    };
    caseDetailsJson = JSON.stringify(detailsObj);

  } catch (pgError) {
    console.error("[InventorySync] Failed to fetch case history/details from PG:", pgError);
  }

  // Every distinct part ordered against this case (Good Part No / Part Order No
  // / SO Number live in the raw FieldEZ upload row, not the report row). One
  // inventory item is synced per part — a multi-part case is no longer
  // collapsed to a single item.
  const parts = await fetchCaseParts(row.case_id);

  // Prod-grade sync: push through the Inventory HTTP API when configured.
  // Local dev without INVENTORY_API_URL falls back to the direct SQLite write below.
  if (process.env.INVENTORY_API_URL) {
    try {
      await syncCasePartsViaApi(row, detailsString, detailsObj, latestMeta, parts);
    } catch (error) {
      console.error("[InventorySync] Error syncing to inventory API:", error);
    }
    return;
  }

  // Path to the inventry-web sqlite database (local dev fallback)
  const dbPath =
    process.env.INVENTORY_DB_PATH ||
    "c:/Users/mohamed vaseem/Documents/company ptoject/inventry-web/inventory_backend/db.sqlite3";

  let db: any = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(dbPath);

    const mappedRegion = mapAspCodeToRegion(row.work_location);
    const now = new Date().toISOString();

    // All existing items for this case (one per part).
    const existingItems = db
      .prepare(
        "SELECT id, part_order_number, good_part_number FROM hp_stock_hpstockitem WHERE case_id = ?",
      )
      .all(row.case_id) as Array<{
      id: number;
      part_order_number: string | null;
      good_part_number: string | null;
    }>;

    const insert = db.prepare(`
      INSERT INTO hp_stock_hpstockitem (
        case_id, work_order_id, delivery_no, service_event_no,
        material_order_no, hp_sales_order_no, gvrma_no,
        region, status, engineer_name, engineer_phone,
        part_description, customer_name,
        good_part_number, part_order_number, so_number, inventory_details,
        opencall_case_details, transition_history, created_at, updated_at,
        warranty_trade, part_shipment_status, dc_cut_request_message,
        dc_cut_approved, dc_cut_chat,
        case_created_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Fill blanks only + refresh the snapshot fields; never touch status or
    // transition_history. Scoped to ONE item by id (a case now has several).
    const update = db.prepare(`
      UPDATE hp_stock_hpstockitem
      SET
        work_order_id = COALESCE(NULLIF(work_order_id, ''), ?),
        region = COALESCE(NULLIF(region, ''), ?),
        engineer_name = CASE WHEN NULLIF(TRIM(?), '') IS NOT NULL THEN TRIM(?) ELSE engineer_name END,
        part_description = CASE WHEN part_description = '' OR part_description IS NULL THEN ? ELSE part_description END,
        customer_name = CASE WHEN customer_name = '' OR customer_name IS NULL THEN ? ELSE customer_name END,
        good_part_number = COALESCE(NULLIF(good_part_number, ''), ?),
        part_order_number = COALESCE(NULLIF(part_order_number, ''), ?),
        so_number = COALESCE(NULLIF(so_number, ''), ?),
        inventory_details = ?,
        opencall_case_details = ?,
        case_created_time = ?,
        updated_at = ?
      WHERE id = ?
    `);

    const claimed = new Set<number>();
    for (const part of parts) {
      const existing = existingItems.find(
        (it) => !claimed.has(it.id) && itemMatchesPart(it, part),
      );

      if (!existing) {
        insert.run(
          row.case_id,          // case_id
          row.ticket_id,        // work_order_id
          "",                   // delivery_no
          "",                   // service_event_no
          "",                   // material_order_no
          "",                   // hp_sales_order_no
          "",                   // gvrma_no
          mappedRegion,         // region
          "PENDING",            // status (Stock Entry)
          row.engineer ?? "",   // engineer_name
          "",                   // engineer_phone
          row.part ?? "",       // part_description
          row.customer_name ?? "", // customer_name
          part.goodPartNumber,  // good_part_number
          part.partOrderNumber, // part_order_number
          part.soNumber,        // so_number
          detailsString,        // inventory_details
          caseDetailsJson,      // opencall_case_details
          "[]",                 // transition_history
          now,                  // created_at
          now,                  // updated_at
          "",                   // warranty_trade (NOT NULL, no DB default)
          "",                   // part_shipment_status (NOT NULL, no DB default)
          "",                   // dc_cut_request_message (NOT NULL, no DB default)
          0,                    // dc_cut_approved (NOT NULL bool)
          "[]",                 // dc_cut_chat (NOT NULL JSON list)
          latestMeta?.case_created_time ?? null, // case_created_time
        );
        console.info(
          `[InventorySync] Created HPStockItem for case ${row.case_id} part ${part.partOrderNumber || part.goodPartNumber || "(none)"}`,
        );
        continue;
      }

      claimed.add(existing.id);
      update.run(
        row.ticket_id,
        mappedRegion,
        row.engineer ?? "", // engineer_name — CASE WHEN NULLIF(TRIM(?), '')...
        row.engineer ?? "", // engineer_name — ...THEN TRIM(?) (same value, bound twice)
        row.part ?? "",
        row.customer_name ?? "",
        part.goodPartNumber,
        part.partOrderNumber,
        part.soNumber,
        detailsString,
        caseDetailsJson,
        latestMeta?.case_created_time ?? null,
        now,
        existing.id,
      );
      console.info(
        `[InventorySync] Updated HPStockItem for case ${row.case_id} part ${part.partOrderNumber || part.goodPartNumber || "(none)"}`,
      );
    }
  } catch (error) {
    console.error("[InventorySync] Error syncing to inventory db:", error);
  } finally {
    if (db) {
      try {
        db.close();
      } catch (err) {
        console.error("[InventorySync] Error closing database connection:", err);
      }
    }
  }
}