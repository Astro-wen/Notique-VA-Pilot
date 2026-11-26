import { timingSafeEqual } from "node:crypto";
import { advanceEventById, sttToken } from "@/lib/server/rpc";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Callback from the transcription service when a recording is ready (or failed).
 * It only nudges the event forward. The transcript itself is fetched from the service with our own key,
 * so nothing in the request body is trusted.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const eventId = url.searchParams.get("e") ?? "";
  const given = Buffer.from(url.searchParams.get("k") ?? "");
  const expected = Buffer.from(/^[0-9a-f-]{36}$/i.test(eventId) ? sttToken(eventId) : "");
  if (expected.length === 0 || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return new Response("Not allowed.", { status: 401 });
  }
  try {
    await advanceEventById(eventId);
  } catch (err) {
    console.error("stt callback failed", err);
    return new Response("Failed.", { status: 500 });
  }
  return new Response("ok");
}
