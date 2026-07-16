import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { env } from "../config/env.js";
import { badRequest } from "../utils/httpError.js";

// Single-file upload for the Flex Closure ASP Report. Kept separate from the main
// report-upload middleware so that flow is completely untouched.
const ALLOWED_EXTENSIONS = new Set([".xls", ".xlsx"]);
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => {
    try {
      fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
      callback(null, env.UPLOAD_DIR);
    } catch (error) {
      callback(
        error instanceof Error ? error : new Error("Unable to create upload directory"),
        env.UPLOAD_DIR,
      );
    }
  },
  filename: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${Date.now()}-${randomUUID()}${extension}`);
  },
});

export const closureUploadMiddleware = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      callback(
        badRequest("Only Excel files are supported", {
          originalFileName: file.originalname,
        }),
      );
      return;
    }
    callback(null, true);
  },
}).single("closureReport");
