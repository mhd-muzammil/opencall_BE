import type { AuthenticatedUser } from "../types/auth.js";
import {
  createHistorySession,
  deleteHistorySession,
  findHistorySessionById,
  getHistorySessionById,
  listHistorySessions,
  updateHistorySessionTitle,
} from "../repositories/historyRepository.js";
import { forbidden, unprocessableEntity } from "../utils/httpError.js";

function mapHistorySession(s: {
  id: string;
  title: string;
  status: "DRAFT" | "COMPLETED";
  region_id: string | null;
  flex_upload_batch_id: string | null;
  renderways_upload_batch_id: string | null;
  call_plan_upload_batch_id: string | null;
  daily_call_plan_report_id: string | null;
  report_date: string | null;
  total_rows: number;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    regionId: s.region_id,
    flexUploadBatchId: s.flex_upload_batch_id,
    renderwaysUploadBatchId: s.renderways_upload_batch_id,
    callPlanUploadBatchId: s.call_plan_upload_batch_id,
    reportId: s.daily_call_plan_report_id,
    reportDate: s.report_date,
    totalRows: s.total_rows,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

export async function listReportHistory(user: AuthenticatedUser) {
  const sessions = await listHistorySessions({
    userId: user.id,
    // Completed reports are shared, all-region artifacts. Every role sees all
    // completed sessions (plus their own drafts) so the latest uploaded report
    // is the global default for everyone, regardless of who generated it.
    includeCompletedFromOthers: true,
  });
  return sessions.map(mapHistorySession);
}

export async function getReportHistoryDetail(
  id: string,
  user: AuthenticatedUser,
) {
  const ownSession = await getHistorySessionById(id, user.id);
  if (ownSession) {
    return mapHistorySession(ownSession);
  }

  // Any authenticated user may open a shared COMPLETED report — required so the
  // global latest report can be auto-restored regardless of who created it.
  const sharedSession = await findHistorySessionById(id);
  if (sharedSession && sharedSession.status === "COMPLETED") {
    return mapHistorySession(sharedSession);
  }

  throw unprocessableEntity("History session not found");
}

export async function renameReportHistory(
  id: string,
  user: AuthenticatedUser,
  title: string,
) {
  if (user.role !== "SUPER_ADMIN") {
    const ownSession = await getHistorySessionById(id, user.id);
    if (!ownSession) {
      throw forbidden("REGION_ADMIN cannot rename history sessions owned by other users");
    }
  }
  const session = await updateHistorySessionTitle(id, user.id, title);
  if (!session) {
    throw unprocessableEntity("History session not found");
  }
  return { id: session.id, title: session.title };
}

export async function removeReportHistory(
  id: string,
  user: AuthenticatedUser,
) {
  if (user.role !== "SUPER_ADMIN") {
    const ownSession = await getHistorySessionById(id, user.id);
    if (!ownSession) {
      throw forbidden("REGION_ADMIN cannot delete history sessions owned by other users");
    }
  }
  const success = await deleteHistorySession(id, user.id);
  if (!success) {
    throw unprocessableEntity("History session not found or could not be deleted");
  }
  return { success };
}

export async function duplicateReportHistory(
  id: string,
  user: AuthenticatedUser,
) {
  if (user.role !== "SUPER_ADMIN") {
    throw forbidden("Only SUPER_ADMIN can duplicate report history sessions");
  }
  const existing = await getHistorySessionById(id, user.id);
  if (!existing) {
    throw unprocessableEntity("History session not found");
  }

  const duplicated = await createHistorySession(null, {
    userId: user.id,
    title: `${existing.title} (Copy)`,
    regionId: existing.region_id,
    flexUploadBatchId: existing.flex_upload_batch_id,
    renderwaysUploadBatchId: existing.renderways_upload_batch_id,
    callPlanUploadBatchId: existing.call_plan_upload_batch_id,
  });

  return { id: duplicated.id, title: duplicated.title };
}
