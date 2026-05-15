export function parseCustomDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const dateStr = value.trim();
  
  // Check if it's DD-MM-YYYY HH:mm[:ss] A
  // Example: 06-02-2026 10:23:35 AM or 06-02-2026 10:23 AM
  const regex = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(AM|PM)$/i;
  const match = dateStr.match(regex);
  if (match) {
    const day = parseInt(match[1]!, 10);
    const month = parseInt(match[2]!, 10) - 1; // 0-indexed
    const year = parseInt(match[3]!, 10);
    let hour = parseInt(match[4]!, 10);
    const minute = parseInt(match[5]!, 10);
    const second = match[6] ? parseInt(match[6], 10) : 0;
    const ampm = match[7]!.toUpperCase();

    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;

    const isoString = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}+05:30`;
    const parsed = new Date(isoString);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const fallback = new Date(dateStr);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}
