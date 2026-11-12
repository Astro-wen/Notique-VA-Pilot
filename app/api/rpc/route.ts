import { db, ConfigError } from "@/lib/server/supabase";
import { handlers, PUBLIC_FUNCTIONS, RpcError, type Ctx } from "@/lib/server/rpc";
import { PipelineError } from "@/lib/server/pipeline";
import type { Profile } from "@/lib/types";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  let fn = "";
  try {
    const body = (await request.json().catch(() => null)) as { fn?: unknown; args?: unknown } | null;
    fn = typeof body?.fn === "string" ? body.fn : "";
    const handler = Object.prototype.hasOwnProperty.call(handlers, fn) ? handlers[fn] : null;
    if (!handler) return json({ error: "Unknown request." }, 404);
    const args = body?.args && typeof body.args === "object" ? body.args : {};

    const ctx: Ctx = { profile: null };
    const header = request.headers.get("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (token) {
      const res = await db().auth.getUser(token);
      if (res.data?.user) {
        const row = await db().from("profiles").select("*").eq("id", res.data.user.id).maybeSingle();
        ctx.profile = (row.data as Profile | null) ?? null;
      }
    }
    if (!PUBLIC_FUNCTIONS.has(fn) && !ctx.profile) {
      return json({ error: token ? "This account is not set up yet. Ask your admin to add you." : "Please sign in again." }, 401);
    }
    const data = await handler(ctx, args);
    return json({ data: data ?? null });
  } catch (err) {
    if (err instanceof RpcError) return json({ error: err.message }, err.status);
    if (err instanceof ConfigError) return json({ error: err.message }, 503);
    if (err instanceof PipelineError) return json({ error: err.message }, 502);
    console.error("rpc failed", fn, err);
    return json({ error: "Something went wrong on our side. Try again in a moment." }, 500);
  }
}
