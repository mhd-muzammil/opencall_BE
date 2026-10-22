/**
 * Request parsing for the Ticketing System proxy (Renderways customers and
 * tickets). Pure, so the rules are tested without a network: only known
 * filters reach Renderways, and ids must look like Mongo ObjectIds before they
 * are put into a Renderways URL.
 */

const OBJECT_ID = /^[a-f0-9]{24}$/i;

export const TICKET_STATUSES = [
  "open",
  "assigned",
  "in_progress",
  "awaiting_customer",
  "resolved",
  "closed",
  "cancelled",
] as const;

export const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

/** Renderways ids are Mongo ObjectIds; anything else never reaches its API. */
export function isRenderwaysId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID.test(value);
}

function text(value: unknown, max = 80): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed || undefined;
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? Math.min(number, max) : fallback;
}

export interface CustomerListQuery {
  search?: string | undefined;
  page: number;
  limit: number;
  /** true = active accounts only, false = deactivated only, undefined = all. */
  active?: boolean | undefined;
}

export function parseCustomerListQuery(query: Record<string, unknown>): CustomerListQuery {
  const status = text(query.status);
  return {
    search: text(query.search),
    page: positiveInt(query.page, 1, 10_000),
    limit: positiveInt(query.limit, 25, 100),
    active: status === "active" ? true : status === "inactive" ? false : undefined,
  };
}

export interface TicketListQuery {
  search?: string | undefined;
  /** "active", "archived" or one ticket status. */
  status?: string | undefined;
  priority?: string | undefined;
  overdue?: boolean | undefined;
  page: number;
  limit: number;
}

export function parseTicketListQuery(query: Record<string, unknown>): TicketListQuery {
  const status = text(query.status);
  const priority = text(query.priority);
  const knownStatus =
    status === "active" ||
    status === "archived" ||
    (TICKET_STATUSES as readonly string[]).includes(status ?? "");
  return {
    search: text(query.search),
    status: knownStatus ? status : undefined,
    priority:
      priority && (TICKET_PRIORITIES as readonly string[]).includes(priority) ? priority : undefined,
    overdue: query.overdue === "true" ? true : undefined,
    page: positiveInt(query.page, 1, 10_000),
    limit: positiveInt(query.limit, 25, 100),
  };
}

/** Renderways serves uploads from its API host, and stores their URLs relative to it. */
export function absoluteFileUrl(url: string, base: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}
