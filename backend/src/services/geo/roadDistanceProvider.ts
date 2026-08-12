/**
 * Real road distances from one origin to many destinations.
 *
 * WHY THIS REPLACED A MULTIPLIER
 * ------------------------------
 * Distance was first estimated as straight-line x 1.48, calibrated against three
 * known Chennai runs. Checked against routing over all 50 live Chennai pincodes
 * that turned out to be badly wrong: the true road/straight ratio runs 1.11 to
 * 1.94, and it FALLS with distance — a long run takes highways while a short one
 * winds through streets. The constant missed by 5.2km on average and by over 3km
 * on 17 of 50 pincodes, which is far outside what a dispatcher will accept.
 *
 * OSRM's public server is used because the volume is trivial: five branch
 * offices against a couple of hundred live pincodes, computed once and topped up
 * when a new pincode appears. If that ever stops being true, `OSRM_BASE_URL`
 * points at a self-hosted instance and nothing else changes.
 */

/** One OSRM `table` request per origin; this caps destinations per request. */
const MAX_DESTINATIONS_PER_REQUEST = 90;

const DEFAULT_BASE_URL = "https://router.project-osrm.org";

export interface RoutePoint {
  latitude: number;
  longitude: number;
}

export interface RoadDistanceProvider {
  /**
   * Road distance in km from `origin` to each destination, index-aligned.
   * An element is null when no route exists (an island, or a coordinate that
   * snapped nowhere) — never a fabricated number.
   */
  distancesFrom(
    origin: RoutePoint,
    destinations: readonly RoutePoint[],
  ): Promise<(number | null)[]>;
}

function formatCoordinate(point: RoutePoint): string {
  // OSRM takes lon,lat — the reverse of every other coordinate in this codebase.
  return `${point.longitude},${point.latitude}`;
}

interface OsrmTableResponse {
  code: string;
  message?: string;
  distances?: (number | null)[][];
}

export class OsrmRoadDistanceProvider implements RoadDistanceProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.OSRM_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async distancesFrom(
    origin: RoutePoint,
    destinations: readonly RoutePoint[],
  ): Promise<(number | null)[]> {
    const results: (number | null)[] = [];

    for (let i = 0; i < destinations.length; i += MAX_DESTINATIONS_PER_REQUEST) {
      const batch = destinations.slice(i, i + MAX_DESTINATIONS_PER_REQUEST);
      results.push(...(await this.requestBatch(origin, batch)));
    }

    return results;
  }

  private async requestBatch(
    origin: RoutePoint,
    destinations: readonly RoutePoint[],
  ): Promise<(number | null)[]> {
    if (destinations.length === 0) {
      return [];
    }

    const coordinates = [origin, ...destinations].map(formatCoordinate).join(";");
    const url = `${this.baseUrl}/table/v1/driving/${coordinates}?sources=0&annotations=distance`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let payload: OsrmTableResponse;
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`OSRM responded ${response.status} ${response.statusText}`);
      }
      payload = (await response.json()) as OsrmTableResponse;
    } finally {
      clearTimeout(timer);
    }

    // A transport or quota failure must THROW so the caller retries or aborts.
    // Returning nulls here would be indistinguishable from "no route exists" and
    // would permanently cache a missing distance as a real answer.
    if (payload.code !== "Ok" || !payload.distances?.[0]) {
      throw new Error(`OSRM error: ${payload.code}${payload.message ? ` — ${payload.message}` : ""}`);
    }

    // Row 0 is the single source; column 0 is the source against itself.
    return payload.distances[0].slice(1).map((metres) =>
      typeof metres === "number" && Number.isFinite(metres) ? metres / 1000 : null,
    );
  }
}
