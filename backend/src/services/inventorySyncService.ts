import { query as pgQuery } from "../config/database.js";

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

    const detailsObj = {
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

  // Path to the inventry-web sqlite database (configurable via env for production)
  const dbPath =
    process.env.INVENTORY_DB_PATH ||
    "c:/Users/mohamed vaseem/Documents/company ptoject/inventry-web/inventory_backend/db.sqlite3";

  let db: any = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(dbPath);

    // Check if a record with case_id already exists in hp_stock_hpstockitem
    const query = db.prepare("SELECT id, status FROM hp_stock_hpstockitem WHERE case_id = ?");
    const existing = query.all(row.case_id) as Array<{ id: number; status: string }>;

    const mappedRegion = mapAspCodeToRegion(row.work_location);
    const now = new Date().toISOString();

    if (existing.length === 0) {
      // Insert new record
      const insert = db.prepare(`
        INSERT INTO hp_stock_hpstockitem (
          case_id, work_order_id, delivery_no, service_event_no, 
          material_order_no, hp_sales_order_no, gvrma_no, 
          region, status, engineer_name, engineer_phone, 
          part_description, customer_name, inventory_details,
          opencall_case_details, transition_history, created_at, updated_at,
          case_created_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

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
        detailsString,        // inventory_details
        caseDetailsJson,      // opencall_case_details
        "[]",                 // transition_history
        now,                  // created_at
        now,                  // updated_at
        latestMeta?.case_created_time ?? null // case_created_time
      );
      console.info(`[InventorySync] Created new HPStockItem for case ${row.case_id}`);
    } else {
      // If it exists, update work_order_id, region, and engineer_name if they are empty or different
      // but do NOT overwrite status or transition history to keep the workflow intact!
      const update = db.prepare(`
        UPDATE hp_stock_hpstockitem
        SET 
          work_order_id = COALESCE(NULLIF(work_order_id, ''), ?),
          region = COALESCE(NULLIF(region, ''), ?),
          engineer_name = CASE WHEN engineer_name = '' OR engineer_name IS NULL THEN ? ELSE engineer_name END,
          part_description = CASE WHEN part_description = '' OR part_description IS NULL THEN ? ELSE part_description END,
          customer_name = CASE WHEN customer_name = '' OR customer_name IS NULL THEN ? ELSE customer_name END,
          inventory_details = ?,
          opencall_case_details = ?,
          case_created_time = ?,
          updated_at = ?
        WHERE case_id = ?
      `);
      update.run(
        row.ticket_id,
        mappedRegion,
        row.engineer ?? "",
        row.part ?? "",
        row.customer_name ?? "",
        detailsString,
        caseDetailsJson,
        latestMeta?.case_created_time ?? null,
        now,
        row.case_id
      );
      console.info(`[InventorySync] Updated existing HPStockItem for case ${row.case_id}`);
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