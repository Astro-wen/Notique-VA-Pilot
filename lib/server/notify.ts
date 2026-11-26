/**
 * Outbound messages to users: email through Resend, text through Twilio.
 * Each channel works only when its keys are set in Vercel. Nothing here is called with AI text that a VA has not seen.
 */

export interface Channels {
  email: boolean;
  sms: boolean;
}

export function channels(): Channels {
  return {
    email: !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM,
    sms: !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN && !!process.env.TWILIO_FROM,
  };
}

/** E.164, for example +13105551234. US numbers typed without a country code get +1. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  const only = digits.replace(/\D/g, "");
  if (only.length === 10) return `+1${only}`;
  if (only.length === 11 && only.startsWith("1")) return `+${only}`;
  return null;
}

export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) throw new Error("Email is not set up. Add RESEND_API_KEY and EMAIL_FROM in Vercel.");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: subject.slice(0, 150), text }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Email was not accepted: ${body?.message ?? res.statusText}`);
  }
}

export async function sendSms(to: string, body: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) throw new Error("Text messages are not set up. Add the three TWILIO variables in Vercel.");
  const form = new URLSearchParams({ To: to, Body: body.slice(0, 1500) });
  // TWILIO_FROM is either a phone number or a Messaging Service SID.
  if (from.startsWith("MG")) form.set("MessagingServiceSid", from);
  else form.set("From", from);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    signal: AbortSignal.timeout(20000),
    headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) {
    const out = await res.json().catch(() => ({}));
    throw new Error(`Text was not accepted: ${out?.message ?? res.statusText}`);
  }
}
