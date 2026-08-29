/**
 * Date comparison for the FieldEZ report date fields.
 *
 * Its own module on purpose: `fieldezSyncWorker.ts` calls `await main()` at the top
 * level and registers signal handlers, so importing it from a test would launch the
 * worker. Nothing here has side effects.
 */

/**
 * Do two "YYYY-M-D"-ish strings name the same calendar day?
 *
 * Compared as numbers, because FieldEZ echoes a date back without the leading zero on
 * the month ("2026-8-22" for "2026-08-22"). The verification step used a literal string
 * compare, so it warned on every single cycle — a warning that always fires is one
 * nobody reads, and it would have hidden a date that genuinely failed to apply.
 *
 * Anything unparseable falls back to an exact compare rather than being assumed equal:
 * a field that came back as garbage should still warn.
 */
export function sameCalendarDay(a: string, b: string): boolean {
  const parts = (value: string) => {
    const match = /^(\d{4})\D+(\d{1,2})\D+(\d{1,2})$/.exec(value.trim());
    return match
      ? [Number(match[1]), Number(match[2]), Number(match[3])]
      : null;
  };
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) return a === b;
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}
