const DEFAULT_TZ = "America/Los_Angeles";

function safeTz(tz?: string | null): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz || DEFAULT_TZ });
    return tz || DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

export function tzAbbr(tz?: string | null): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: safeTz(tz), timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}

function dayKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** "Today 4:30 PM", "Tomorrow 9:00 AM", "Nov 12, 9:00 AM". */
export function dateTime(iso: string | null | undefined, tz?: string | null, withZone = false): string {
  if (!iso) return "";
  const zone = safeTz(tz);
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(d);
  const today = dayKey(new Date(), zone);
  const tomorrow = dayKey(new Date(Date.now() + 86400000), zone);
  const yesterday = dayKey(new Date(Date.now() - 86400000), zone);
  const key = dayKey(d, zone);
  let day: string;
  if (key === today) day = "Today";
  else if (key === tomorrow) day = "Tomorrow";
  else if (key === yesterday) day = "Yesterday";
  else {
    const sameYear = key.slice(0, 4) === today.slice(0, 4);
    day = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(d) + ",";
  }
  return `${day} ${time}${withZone ? ` ${tzAbbr(zone)}` : ""}`;
}

export function dateOnly(iso: string | null | undefined, tz?: string | null): string {
  if (!iso) return "";
  const zone = safeTz(tz);
  const d = new Date(iso);
  const key = dayKey(d, zone);
  if (key === dayKey(new Date(), zone)) return "Today";
  if (key === dayKey(new Date(Date.now() - 86400000), zone)) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(d);
}

export function plainDate(ymd: string | null | undefined): string {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** "in 3h 20m", "overdue by 45m". */
export function remaining(iso: string | null | undefined): { text: string; tone: "ok" | "soon" | "late" } | null {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const h = Math.floor(mins / 60);
  const d = Math.floor(h / 24);
  const span = d >= 2 ? `${d}d` : h >= 1 ? `${h}h ${mins % 60}m` : `${Math.max(1, mins)}m`;
  if (diff < 0) return { text: `Overdue by ${span}`, tone: "late" };
  return { text: `${span} left`, tone: diff < 2 * 3600 * 1000 ? "soon" : "ok" };
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : dateOnly(iso);
}

export function clock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function minutes(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fileSize(bytes: number | null | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function taskNo(n: number): string {
  return `NQ-${n}`;
}

export function toLocalInput(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const SOURCE_LABEL: Record<string, string> = {
  recording: "Recording",
  transcript_upload: "Transcript",
  text_upload: "Text messages",
  crm: "CRM note",
  voice_memo: "Voice memo",
  note: "Written note",
};

export const CHANNEL_LABEL: Record<string, string> = { in_app: "In app", text: "Text", email: "Email", call: "Call" };

export const TASK_STATUS_LABEL: Record<string, string> = {
  suggested: "Suggested",
  received: "Received",
  in_progress: "In progress",
  waiting: "Waiting on user",
  delivered: "Delivered",
  cancelled: "Cancelled",
  dismissed: "Dismissed",
};

export const FEEDBACK_LABEL: Record<string, string> = {
  used_as_is: "Used as is",
  edited: "Edited before sending",
  not_used: "Not used",
  revision_requested: "Revision requested",
};

const DEAL_LABEL: Record<string, string> = { buyer: "Buyer", seller: "Seller", other: "Other" };

export function projectLine(p: { deal_type: string; area: string | null; budget: string | null }): string {
  return [DEAL_LABEL[p.deal_type] ?? p.deal_type, p.area, p.budget].filter(Boolean).join(", ")
}
