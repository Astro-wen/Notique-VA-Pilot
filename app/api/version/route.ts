export const dynamic = "force-dynamic";

/** The commit that is live right now. Open tabs compare it with the one they were built from. */
export function GET() {
  return Response.json({ version: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" }, { headers: { "cache-control": "no-store" } });
}
