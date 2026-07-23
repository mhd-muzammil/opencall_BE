/**
 * Normalises a `from` / `to` range query pair. Each value is a lexicographically
 * comparable bound — "YYYY-MM" (month) or "YYYY-MM-DD" (day) — or blank. Values are
 * trimmed, and a reversed range (from later than to) is swapped so the caller never has to
 * validate order. A blank bound means "unbounded" on that side.
 */
export function monthRange(
  fromRaw: unknown,
  toRaw: unknown,
): { from: string; to: string } {
  const from = String(fromRaw ?? "").trim();
  const to = String(toRaw ?? "").trim();
  if (from && to && from > to) {
    return { from: to, to: from };
  }
  return { from, to };
}
