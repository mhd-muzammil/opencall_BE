import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { apiRouter } from "./routes/index.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { notFoundHandler } from "./middlewares/notFoundHandler.js";
import { setupAdmin } from "./admin/admin.js";
import { env } from "./config/env.js";

function parseCorsOrigins(value: string): string[] | boolean {
  if (value.trim() === "*") {
    return true;
  }

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export async function createApp() {
  const app = express();

  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  // gzip/deflate all responses. The daily call-plan report JSON is large
  // (thousands of rows × ~30 columns, plus merged raw Excel columns) and
  // compresses ~93%, cutting the post-login report download substantially.
  //
  // Level 2, not zlib's default 6. Compression here is SYNCHRONOUS CPU on the one
  // thread that also runs every other request: while the report is being compressed,
  // nothing else in the process progresses and no database connection is released.
  // Measured on a ~16 MB report payload:
  //
  //   level 6   1.04 MB   267 ms      level 2   1.18 MB   120 ms
  //   level 9   0.98 MB  1733 ms      level 1   1.62 MB   123 ms
  //
  // So level 2 buys back 55% of the CPU for 140 KB, and strictly beats level 1 on
  // both axes. Level 9 is never worth it. Override with COMPRESSION_LEVEL if a
  // deployment is bandwidth-bound rather than CPU-bound.
  const compressionLevel = Number.parseInt(process.env.COMPRESSION_LEVEL ?? "", 10);
  app.use(
    compression({
      level:
        Number.isFinite(compressionLevel) &&
        compressionLevel >= 0 &&
        compressionLevel <= 9
          ? compressionLevel
          : 2,
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "https://adminjs.co"],
        },
      },
    }),
  );

  app.use(
    cors({
      origin: parseCorsOrigins(env.CORS_ORIGIN),
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "x-region-id"],
      maxAge: 86400,
    }),
  );

  // AdminJS must mount before body parsers
  await setupAdmin(app);

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use("/api/v1", apiRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
