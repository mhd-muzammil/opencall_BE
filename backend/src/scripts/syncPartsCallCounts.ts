import { closeDatabasePool } from "../config/database.js";
import { generateDailyCallPlanReport } from "../services/callPlanGenerator/dailyCallPlanGenerator.js";
import { findLatestCompletedReportSession } from "../repositories/historyRepository.js";
import {
  computeActivePartData,
  pushActivePartData,
} from "../services/partsCallCountSync.js";

// Manual/backfill run of the same sync that now fires automatically after every report
// generation. Regenerates the latest completed report (read-only) and pushes its
// region-wise "Active Part Cases" count + case-id list to inventory.

async function run(): Promise<void> {
  const session = await findLatestCompletedReportSession();
  if (!session?.flex_upload_batch_id) {
    console.warn("[PartsCallCounts] No completed report session found");
    return;
  }

  const report = await generateDailyCallPlanReport({
    reportDate: session.report_date ?? "",
    generatedBy: session.user_id,
    regionId: null,
    flexUploadBatchId: session.flex_upload_batch_id,
    renderwaysUploadBatchId: session.renderways_upload_batch_id,
    callPlanUploadBatchId: session.call_plan_upload_batch_id,
    allowCreate: false,
  });

  // force = true: a manual run should always write, even if unchanged.
  await pushActivePartData(computeActivePartData(report), true);
}

run()
  .catch((error: unknown) => {
    console.error("[PartsCallCounts] Failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
