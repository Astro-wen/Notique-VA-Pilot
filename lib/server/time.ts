/** Offset in minutes between UTC and the given IANA zone at a given instant. */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - date.getTime()) / 60000);
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "America/Los_Angeles";
  }
}

/**
 * Default SLA: 9:00 AM on the next business day in the agent's time zone.
 */
export function nextBusinessDayNine(from: Date, tz: string): Date {
  const timeZone = safeZone(tz);
  const offset = tzOffsetMinutes(from, timeZone);
  const local = new Date(from.getTime() + offset * 60000);
  const target = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 9, 0, 0));
  do {
    target.setUTCDate(target.getUTCDate() + 1);
  } while (target.getUTCDay() === 0 || target.getUTCDay() === 6);
  const guess = new Date(target.getTime() - offset * 60000);
  const offsetAtTarget = tzOffsetMinutes(guess, timeZone);
  return new Date(target.getTime() - offsetAtTarget * 60000);
}

export function startOfWeekUtc(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d;
}
