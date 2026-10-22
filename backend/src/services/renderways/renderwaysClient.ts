/**
 * OpenCall -> Renderways integration client (read-only).
 *
 * Renderways (RTPL's customer app and website, rtpl.systimus.in — a separate
 * Node/Express + MongoDB project) owns the customer accounts and the service
 * tickets customers raise. OpenCall's Ticketing System section only READS them,
 * live, through this file — the only place that talks to the Renderways API,
 * mirroring payrollClient. Nothing here writes to Renderways.
 *
 * Config (read from process.env, so config/env.ts needs no edit):
 *   RENDERWAYS_API_URL  e.g. https://tsapi.systimus.in  (or http://localhost:5000)
 *   RENDERWAYS_API_KEY  the service key — the same value as SERVICE_API_KEY on the
 *                       Renderways backend. No Renderways user account is involved:
 *                       the key opens Renderways' read-only /api/integrations routes
 *                       (customers and tickets) and nothing else.
 *
 * When they are unset isRenderwaysConfigured() is false and the section says so.
 */

import { HttpError, notFound } from "../../utils/httpError.js";
import {
  absoluteFileUrl,
  type CustomerListQuery,
  type TicketListQuery,
} from "./ticketingParams.js";

const REQUEST_TIMEOUT_MS = 15_000;

function config() {
  return {
    base: (process.env.RENDERWAYS_API_URL ?? "").trim().replace(/\/+$/, "").replace(/\/api$/, ""),
    key: (process.env.RENDERWAYS_API_KEY ?? "").trim(),
  };
}

export function isRenderwaysConfigured(): boolean {
  const { base, key } = config();
  return Boolean(base && key);
}

// ---- Types (only the fields the Ticketing System shows) -------------------

export interface RwAddress {
  line1?: string;
  city?: string;
  state?: string;
  pincode?: string;
  landmark?: string;
}

export interface RwPagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface RwCustomer {
  id: string;
  name: string;
  /** Missing for customers who signed up with just a mobile number. */
  email: string | null;
  phone: string;
  company: string;
  address: RwAddress;
  isActive: boolean;
  notificationPrefs: { email: boolean; whatsapp: boolean } | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface RwPerson {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
}

export interface RwAttachment {
  url: string;
  filename: string;
  mimetype: string;
  size: number;
}

export interface RwComment {
  id: string;
  author: RwPerson | null;
  message: string;
  /** Staff-only notes inside Renderways; customers never see these. */
  isInternal: boolean;
  attachments: RwAttachment[];
  createdAt: string;
}

export interface RwActivity {
  action: string;
  by: RwPerson | null;
  from: string;
  to: string;
  note: string;
  at: string;
}

export interface RwTicketSummary {
  id: string;
  ticketNumber: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  serviceMode: string;
  customer: RwPerson | null;
  assignedTo: RwPerson | null;
  isOverdue: boolean;
  slaDueAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface RwTicket extends RwTicketSummary {
  description: string;
  device: {
    type: string;
    brand: string;
    model: string;
    serialNumber: string;
    underWarranty: boolean;
  } | null;
  location: RwAddress | null;
  customerCompany: string;
  preferredSlot: string | null;
  attachments: RwAttachment[];
  comments: RwComment[];
  activity: RwActivity[];
  estimatedCost: number | null;
  finalCost: number | null;
  resolutionSummary: string;
  rating: { stars: number; feedback: string; ratedAt: string | null } | null;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
}

// ---- HTTP -----------------------------------------------------------------

/** GET one of Renderways' read-only integration routes (/api/integrations/...) with the service key. */
async function get<T>(path: string): Promise<T> {
  if (!isRenderwaysConfigured()) {
    throw new HttpError(
      503,
      "The Renderways integration is not configured (set RENDERWAYS_API_URL and RENDERWAYS_API_KEY)",
    );
  }
  const { base, key } = config();

  let response: Response;
  try {
    response = await fetch(`${base}/api/integrations${path}`, {
      headers: { "X-Service-Key": key },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, "The Renderways API could not be reached");
  }

  if (response.status === 401) {
    throw new HttpError(
      502,
      "Renderways rejected the service key (401). RENDERWAYS_API_KEY must be the same as SERVICE_API_KEY on the Renderways backend.",
    );
  }
  if (response.status === 503) {
    throw new HttpError(
      502,
      "Renderways has service access turned off. Set SERVICE_API_KEY on the Renderways backend and redeploy it.",
    );
  }
  if (response.status === 404) {
    throw notFound("Not found in Renderways");
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new HttpError(502, `Renderways API ${path} failed (${response.status}): ${detail.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

// ---- Mapping (Renderways documents -> the shapes above) -------------------

type Doc = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
const docs = (value: unknown): Doc[] => (Array.isArray(value) ? (value as Doc[]) : []);
const idOf = (doc: Doc): string => str(doc._id) || str(doc.id);

function address(value: unknown): RwAddress {
  const doc = (value ?? {}) as Doc;
  return {
    line1: str(doc.line1),
    city: str(doc.city),
    state: str(doc.state),
    pincode: str(doc.pincode),
    landmark: str(doc.landmark),
  };
}

function person(value: unknown): RwPerson | null {
  if (!value || typeof value !== "object") return null;
  const doc = value as Doc;
  return {
    id: idOf(doc),
    name: str(doc.name),
    email: strOrNull(doc.email),
    phone: strOrNull(doc.phone),
    role: strOrNull(doc.role),
  };
}

function attachments(value: unknown, base: string): RwAttachment[] {
  return docs(value)
    .filter((doc) => str(doc.url))
    .map((doc) => ({
      url: absoluteFileUrl(str(doc.url), base),
      filename: str(doc.filename),
      mimetype: str(doc.mimetype),
      size: num(doc.size) ?? 0,
    }));
}

function toCustomer(doc: Doc): RwCustomer {
  const prefs = doc.notificationPrefs as Doc | undefined;
  return {
    id: idOf(doc),
    name: str(doc.name),
    email: strOrNull(doc.email),
    phone: str(doc.phone),
    company: str(doc.company),
    address: address(doc.address),
    isActive: doc.isActive !== false,
    notificationPrefs: prefs
      ? { email: prefs.email !== false, whatsapp: prefs.whatsapp !== false }
      : null,
    lastLoginAt: strOrNull(doc.lastLoginAt),
    createdAt: str(doc.createdAt),
  };
}

function toTicketSummary(doc: Doc): RwTicketSummary {
  return {
    id: idOf(doc),
    ticketNumber: str(doc.ticketNumber),
    subject: str(doc.subject),
    category: str(doc.category),
    priority: str(doc.priority),
    status: str(doc.status),
    serviceMode: str(doc.serviceMode),
    customer: person(doc.customer),
    assignedTo: person(doc.assignedTo),
    isOverdue: doc.isOverdue === true,
    slaDueAt: strOrNull(doc.slaDueAt),
    createdAt: str(doc.createdAt),
    updatedAt: strOrNull(doc.updatedAt),
  };
}

function toTicket(doc: Doc, base: string): RwTicket {
  const device = doc.device as Doc | undefined;
  const rating = doc.rating as Doc | undefined;
  const customer = doc.customer as Doc | undefined;
  return {
    ...toTicketSummary(doc),
    description: str(doc.description),
    device: device
      ? {
          type: str(device.type),
          brand: str(device.brand),
          model: str(device.model),
          serialNumber: str(device.serialNumber),
          underWarranty: device.underWarranty === true,
        }
      : null,
    location: doc.location ? address(doc.location) : null,
    customerCompany: customer ? str(customer.company) : "",
    preferredSlot: strOrNull(doc.preferredSlot),
    attachments: attachments(doc.attachments, base),
    comments: docs(doc.comments).map((comment) => ({
      id: idOf(comment),
      author: person(comment.author),
      message: str(comment.message),
      isInternal: comment.isInternal === true,
      attachments: attachments(comment.attachments, base),
      createdAt: str(comment.createdAt),
    })),
    activity: docs(doc.activity).map((entry) => ({
      action: str(entry.action),
      by: person(entry.by),
      from: str(entry.from),
      to: str(entry.to),
      note: str(entry.note),
      at: str(entry.at),
    })),
    estimatedCost: num(doc.estimatedCost),
    finalCost: num(doc.finalCost),
    resolutionSummary: str(doc.resolutionSummary),
    rating:
      rating && typeof rating.stars === "number" && rating.stars > 0
        ? { stars: rating.stars, feedback: str(rating.feedback), ratedAt: strOrNull(rating.ratedAt) }
        : null,
    firstRespondedAt: strOrNull(doc.firstRespondedAt),
    resolvedAt: strOrNull(doc.resolvedAt),
    closedAt: strOrNull(doc.closedAt),
  };
}

// ---- Reads ------------------------------------------------------------------

export async function listCustomers(
  query: CustomerListQuery,
): Promise<{ customers: RwCustomer[]; pagination: RwPagination }> {
  // Renderways only ever lists customers on this route.
  const params = new URLSearchParams({
    page: String(query.page),
    limit: String(query.limit),
    sort: "-createdAt",
  });
  if (query.search) params.set("search", query.search);
  if (query.active !== undefined) params.set("isActive", String(query.active));

  const body = await get<{ users: Doc[]; pagination: RwPagination }>(`/customers?${params}`);
  return {
    customers: body.users.filter((user) => user.role === "customer").map(toCustomer),
    pagination: body.pagination,
  };
}

export async function listTickets(
  query: TicketListQuery & { customerId?: string },
): Promise<{ tickets: RwTicketSummary[]; pagination: RwPagination }> {
  const params = new URLSearchParams({
    page: String(query.page),
    limit: String(query.limit),
    sort: "-createdAt",
  });
  if (query.search) params.set("search", query.search);
  if (query.status) params.set("status", query.status);
  if (query.priority) params.set("priority", query.priority);
  if (query.overdue) params.set("overdue", "true");
  if (query.customerId) params.set("customer", query.customerId);

  const body = await get<{ tickets: Doc[]; pagination: RwPagination }>(`/tickets?${params}`);
  return { tickets: body.tickets.map(toTicketSummary), pagination: body.pagination };
}

/** A customer, their ticket counts and their tickets (newest first). */
export async function getCustomer(id: string): Promise<{
  customer: RwCustomer;
  stats: { totalTickets: number; openTickets: number };
  tickets: RwTicketSummary[];
  ticketPagination: RwPagination;
}> {
  const body = await get<{ user: Doc; stats?: { totalTickets?: number; openTickets?: number } }>(
    `/customers/${id}`,
  );
  // This section is about customers; staff accounts are not shown here.
  if (body.user.role !== "customer") {
    throw notFound("Not a Renderways customer");
  }
  const { tickets, pagination } = await listTickets({ customerId: id, page: 1, limit: 100 });
  return {
    customer: toCustomer(body.user),
    stats: {
      totalTickets: body.stats?.totalTickets ?? pagination.total,
      openTickets: body.stats?.openTickets ?? 0,
    },
    tickets,
    ticketPagination: pagination,
  };
}

export async function getTicket(id: string): Promise<RwTicket> {
  const body = await get<{ ticket: Doc }>(`/tickets/${id}`);
  return toTicket(body.ticket, config().base);
}
