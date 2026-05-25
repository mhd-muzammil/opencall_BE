import type { Request } from "express";
import type { UserRole } from "@opencall/shared";
import {
  insertActivity,
  type ActivityEventType,
  type ActivityStatus,
} from "../../repositories/activityLogRepository.js";

export interface RecordActivityInput {
  eventType: ActivityEventType;
  actor?: {
    id: string | null;
    email: string | null;
    role: UserRole | null;
  } | null;
  actorEmailFallback?: string | null;
  regionId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  status?: ActivityStatus;
  request?: Request | null;
}

function extractIp(request: Request | null | undefined): string | null {
  if (!request) return null;
  const forwarded = request.header("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || null;
  }
  return request.ip ?? null;
}

function extractUserAgent(request: Request | null | undefined): string | null {
  if (!request) return null;
  const ua = request.header("user-agent");
  return ua ? ua.slice(0, 500) : null;
}

export function recordActivity(input: RecordActivityInput): void {
  const payload = {
    actorUserId: input.actor?.id ?? null,
    actorEmail: input.actor?.email ?? input.actorEmailFallback ?? null,
    actorRole: input.actor?.role ?? null,
    regionId: input.regionId ?? null,
    eventType: input.eventType,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    ipAddress: extractIp(input.request),
    userAgent: extractUserAgent(input.request),
    metadata: input.metadata ?? {},
    status: input.status ?? "SUCCESS",
  };

  insertActivity(payload).catch((error) => {
    console.error("[activityLogger] failed to record event", {
      eventType: payload.eventType,
      error,
    });
  });
}
