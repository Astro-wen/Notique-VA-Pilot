import { reconcileEvents, runDueWatches, sendMorningBriefs } from "@/lib/server/rpc";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Daily job, called by Vercel Cron (see vercel.json).
 * When CRON_SECRET is set in Vercel, only requests carrying it are accepted.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  // With CRON_SECRET set, only Vercel Cron can run this. Without it, at least require Vercel Cron's own user agent,
  // which keeps casual visitors and crawlers out. Set CRON_SECRET in Vercel for real protection.
  const allowed = secret ? request.headers.get("authorization") === `Bearer ${secret}` : (request.headers.get("user-agent") ?? "").includes("vercel-cron");
  if (!allowed) {
    return new Response(JSON.stringify({ error: "Not allowed." }), { status: 401, headers: { "content-type": "application/json" } });
  }
  try {
    const events = await reconcileEvents().catch(() => ({ advanced: 0 }));
    const briefs = await sendMorningBriefs().catch(() => ({ sent: 0, skipped: 0 }));
    const watches = await runDueWatches(150000);
    return new Response(JSON.stringify({ ok: true, events, briefs, watches }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (err) {
    console.error("daily job failed", err);
    return new Response(JSON.stringify({ error: "The daily job failed." }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
