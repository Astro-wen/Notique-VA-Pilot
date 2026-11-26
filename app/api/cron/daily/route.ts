import { runDueWatches } from "@/lib/server/rpc";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Daily job, called by Vercel Cron (see vercel.json).
 * When CRON_SECRET is set in Vercel, only requests carrying it are accepted.
 * Without it the job is still safe to expose: each watch is checked at most once every 20 hours.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response(JSON.stringify({ error: "Not allowed." }), { status: 401, headers: { "content-type": "application/json" } });
  }
  try {
    const watches = await runDueWatches();
    return new Response(JSON.stringify({ ok: true, watches }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (err) {
    console.error("daily job failed", err);
    return new Response(JSON.stringify({ error: "The daily job failed." }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
