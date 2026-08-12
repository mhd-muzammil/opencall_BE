import multer from "multer";
import { MAX_ATTACHMENT_TOTAL_BYTES } from "../services/inboundEmail/composeValidator.js";

/**
 * Attachments for Compose, held in memory.
 *
 * Unlike the report uploads, these are never a file on this server: they go straight into
 * `outbound_email_attachments` and into the SMTP envelope. Memory storage keeps it that
 * way — there is no temp file to leak a customer's document, and no volume to provision on
 * the container.
 *
 * The multer limits below are the outer wall; `checkCompose` re-checks the total, because
 * multer's per-file cap cannot see the sum.
 */
export const composeAttachmentMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_ATTACHMENT_TOTAL_BYTES,
    files: 10,
    // Field values (subject, body) are text; this stops a body being used as a smuggling
    // channel for something much larger than the editor could produce.
    fieldSize: 1024 * 1024,
  },
}).array("attachments", 10);
