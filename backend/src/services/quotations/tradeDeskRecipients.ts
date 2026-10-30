import { ASP_CODE_REGION_MAP } from "@opencall/shared";
import { listActiveMailboxes } from "../../repositories/inboundEmailRepository.js";
import { findQuotationWorkLocation } from "../../repositories/quotationRepository.js";
import {
  DESK_MAIL_FALLBACK_BRANCH,
  DESK_MAIL_FROM_MAILBOX,
  deskMailCc,
} from "./tradeDeskMail.js";

/** The five branches, as region mailboxes and the ASP map both name them. */
const BRANCHES = Object.values(ASP_CODE_REGION_MAP).map((name) => name.trim().toUpperCase());

/**
 * The branch a work location belongs to, the way the Quotations page's location cards read
 * it: the ASP code through the shared map, else a branch named inside the value. Null when
 * neither says — the caller decides what an unknown branch means.
 */
export function branchOfWorkLocation(workLocation: string): string | null {
  const value = String(workLocation ?? "").trim().toUpperCase();
  if (!value) return null;
  const mapped = ASP_CODE_REGION_MAP[value];
  if (mapped) return mapped.trim().toUpperCase();
  return BRANCHES.find((branch) => value.includes(branch)) ?? null;
}

export interface DeskMailRecipients {
  /** The trade desk's address the mail leaves from; null when that mailbox is not set up. */
  from: string | null;
  /** The customer's branch, or Chennai when it cannot be told. */
  branch: string;
  cc: string[];
}

/**
 * Where a quotation mail, Visit or Part, comes from and who it is copied to: always from the
 * trade desk, copied to the desk's two and the customer's branch.
 *
 * The branch mailbox's address comes from the configured mailboxes, never built from the
 * branch's name — the addresses are configuration, not a pattern. A branch whose mailbox is
 * not configured falls back to Chennai's, as an unknown branch does: the head office, as on
 * the desk's own mail. The sender sees and can change the list before anything is sent.
 */
export async function deskMailRecipients(quotationId: string): Promise<DeskMailRecipients> {
  const workLocation = await findQuotationWorkLocation(quotationId);
  const branch = branchOfWorkLocation(workLocation) ?? DESK_MAIL_FALLBACK_BRANCH;
  const mailboxes = await listActiveMailboxes();
  const mailboxOf = (code: string) =>
    mailboxes.find((box) => box.regionCode.trim().toUpperCase() === code)?.email ?? null;
  return {
    from: mailboxOf(DESK_MAIL_FROM_MAILBOX),
    branch,
    cc: deskMailCc(mailboxOf(branch) ?? mailboxOf(DESK_MAIL_FALLBACK_BRANCH)),
  };
}
