import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const apiRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

dotenv.config({ path: path.join(apiRoot, ".env") });

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_ACCESS_SECRET: z.string().min(1, "JWT_ACCESS_SECRET is required"),
  // How long a bearer token stays valid. With the sliding refresh in
  // /auth/refresh this is effectively an IDLE timeout: an open tab renews itself
  // well before expiry, so only a session left untouched this long has to log in
  // again. It used to be a hard-coded 8h, which expired mid-shift for anyone who
  // signed in first thing in the morning.
  JWT_ACCESS_TTL_HOURS: z.coerce.number().positive().max(720).default(12),
  UPLOAD_DIR: z.string().min(1).default("./storage/uploads"),
  CORS_ORIGIN: z.string().min(1).default("http://localhost:3000"),
  ADMIN_COOKIE_SECRET: z.string().min(1).default("dev-admin-cookie-secret-change-me"),
  ADMIN_SESSION_SECRET: z.string().min(1).default("dev-admin-session-secret-change-me"),
  // Flex Raw Data API — the standalone raw-data project's HTTP endpoint. When set, the
  // Closed Calls "Sync Raw Data" action pulls the raw closed-call rows from here. Left
  // blank the sync is simply unavailable (the region cards still work without it).
  FLEX_RAW_API_URL: z.string().url().optional().or(z.literal("")).default(""),
  FLEX_RAW_API_KEY: z.string().optional().default(""),
  // Geocoding (migration 045). "none" is the supported default: the
  // pincode-centroid tier runs on its own, every work order still gets a
  // coordinate, and the coverage telemetry still fills — so this ships to
  // production before any maps account exists.
  GEOCODE_PROVIDER: z.enum(["none", "ola", "geoapify", "opencage"]).default("none"),
  OLA_MAPS_API_KEY: z.string().optional().default(""),
  // Geoapify and OpenCage both explicitly permit storing results in your own
  // database, which is what geocode_cache is — so with either of them
  // GEOCODE_CACHE_TTL_DAYS can stay at 0 rather than being a hedge.
  GEOAPIFY_API_KEY: z.string().optional().default(""),
  OPENCAGE_API_KEY: z.string().optional().default(""),
  // How long a cached geocode may be reused, in days. 0 = never expire, which is
  // the correct behaviour when the provider's terms permit indefinite storage.
  //
  // This exists because Ola's data-retention clause could not be verified before
  // the cache was built, and some vendors cap storage at 30 days. Turning it on
  // costs almost nothing — re-geocoding every distinct address monthly is a few
  // thousand calls against a 500,000/month allowance — whereas retrofitting the
  // capability later would have meant reworking the cache.
  GEOCODE_CACHE_TTL_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV !== "production") {
    return;
  }

  const productionSecrets = [
    ["JWT_ACCESS_SECRET", env.JWT_ACCESS_SECRET],
    ["ADMIN_COOKIE_SECRET", env.ADMIN_COOKIE_SECRET],
    ["ADMIN_SESSION_SECRET", env.ADMIN_SESSION_SECRET],
  ] as const;

  for (const [name, value] of productionSecrets) {
    if (
      value.length < 32 ||
      value.includes("change-me") ||
      value.includes("change-this") ||
      value.includes("replace-with")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: `${name} must be a strong production secret with at least 32 characters`,
      });
    }
  }

  if (env.CORS_ORIGIN === "*") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["CORS_ORIGIN"],
      message: "CORS_ORIGIN must be restricted in production",
    });
  }
});

export const env = envSchema.parse(process.env);
