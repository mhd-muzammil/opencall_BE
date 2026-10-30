import multer from "multer";

/**
 * The one upload a quotation send carries: the Visit sheet as a PDF, held in memory.
 *
 * Sized for that and nothing more, rather than borrowing Compose's limits (ten files of
 * 20 MB, and no cap on the number of fields): the sheet is about a megabyte for its two
 * pages, the text fields are a few short lines, and anything beyond that is not a send.
 * Mounted after the access check, so a login with no business here is refused before any
 * of the body is read.
 *
 * A JSON body — every Part send — passes through untouched; multer reads only multipart.
 */
export const quotationEstimateUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 15 * 1024 * 1024,
    // regionCode, to, cc, note, renderedVersion — with room to spare.
    fields: 10,
    fieldSize: 16 * 1024,
    parts: 12,
  },
}).array("attachments", 1);
