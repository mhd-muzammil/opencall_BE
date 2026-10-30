import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  listQuotationsAwaitingReply,
  listQuotationsNeedingSendCheck,
  listRepliesForQuotation,
  listReplyImages,
  listUnplacedRepliesFromCustomer,
} from "./quotationWatchRepository.js";
import { visitQuotationInlineImages } from "../services/quotations/visitQuotationMail.js";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../config/database.js", () => ({ query: mocks.query, pool: { connect: vi.fn() } }));

/** Whitespace-collapsed SQL, so assertions read the statement rather than its layout. */
function squash(sql: unknown): string {
  return String(sql).replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  mocks.query.mockReset();
});

describe("listQuotationsAwaitingReply", () => {
  /**
   * A Visit quotation paid in the morning and the Part quotation raised that afternoon share a
   * work order. Counted from the Part's DATE, the morning's "payment done" would settle it.
   */
  it("starts an unsent quotation's watch when it was raised, never before its date", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await listQuotationsAwaitingReply();
    const sql = squash(mocks.query.mock.calls[0]![0]);
    const watch = "COALESCE(sent_at, GREATEST(quotation_date::timestamptz, created_at))";
    expect(sql).toContain(`${watch}::TEXT AS watch_from`);
    expect(sql).toContain(`ORDER BY ${watch}`);
    expect(sql).not.toContain("COALESCE(sent_at, quotation_date::timestamptz)");
  });
});

describe("listQuotationsNeedingSendCheck", () => {
  it("carries when each quotation was raised, to the second", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: "q-81",
          quotation_no: "RTPL/26-27/QEN/81",
          order_number: "WO-036344461",
          customer_email: "customer@example.com",
          raised_at: "2026-10-29 00:00:00+05:30",
          created_at: "2026-10-29 16:00:00+05:30",
        },
      ],
    });
    const [check] = await listQuotationsNeedingSendCheck({ limit: 8, recheckAfterHours: 24 });
    expect(squash(mocks.query.mock.calls[0]![0])).toContain("created_at::TEXT AS created_at");
    expect(check).toMatchObject({ raisedAt: "2026-10-29 00:00:00+05:30", createdAt: "2026-10-29 16:00:00+05:30" });
  });
});

/**
 * The Visit mail's own signature pictures, sent back in a reply as ordinary attachments by
 * some mail clients, must never count as the customer's picture: with them, a bare "payment
 * done" would read as proven.
 */
describe("the pictures a reply carried", () => {
  const ours = visitQuotationInlineImages();
  const hashes = ours.map((image) => createHash("md5").update(image.content).digest("hex"));

  async function sqlOf(run: () => Promise<unknown>): Promise<string> {
    mocks.query.mockResolvedValue({ rows: [] });
    await run();
    return squash(mocks.query.mock.calls[0]![0]);
  }

  it.each([
    ["listRepliesForQuotation", () => listRepliesForQuotation({ orderNumber: "WO-1", watchFrom: "2026-10-30" })],
    ["listUnplacedRepliesFromCustomer", () => listUnplacedRepliesFromCustomer({ fromEmail: "c@example.com", watchFrom: "2026-10-30" })],
    ["listReplyImages", () => listReplyImages("e-1")],
  ])("%s leaves our own signature pictures out", async (_name, run) => {
    const sql = await sqlOf(run);
    for (const hash of hashes) expect(sql).toContain(`'${hash}'`);
    expect(sql).toContain("md5(a.content) IN (");
    expect(sql).toContain("a.content_id ILIKE '%@opencall%'");
    expect(sql).toContain("'hp.png'");
  });
});
