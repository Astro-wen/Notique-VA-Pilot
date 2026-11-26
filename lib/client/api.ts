"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "@/lib/config";

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  return client;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const session = (await supabase().auth.getSession()).data.session;
  let res: Response;
  try {
    res = await fetch("/api/rpc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session ? { authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({ fn, args }),
    });
  } catch {
    throw new ApiError("You appear to be offline. Check your connection and try again.", 0);
  }
  const body = (await res.json().catch(() => null)) as { data?: T; error?: string } | null;
  if (!res.ok || !body) {
    throw new ApiError(body?.error ?? "Something went wrong. Try again in a moment.", res.status);
  }
  return body.data as T;
}

/** Storage rejects bigger files. The Supabase Free plan is fixed at 50 MB; raise NEXT_PUBLIC_MAX_UPLOAD_MB after upgrading. */
export const MAX_UPLOAD_MB = Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB) || 50;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/** Why a file cannot be uploaded, in words a user can act on, or null when it is fine. */
export function uploadProblem(file: File): string | null {
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size <= MAX_UPLOAD_BYTES) return null;
  const mb = Math.round(file.size / 1024 / 1024);
  const audio = /^audio\/|^video\//.test(file.type) || /\.(wav|m4a|mp3|mp4|aac|caf|aiff?)$/i.test(file.name);
  return audio
    ? `"${file.name}" is ${mb} MB and the limit is ${MAX_UPLOAD_MB} MB. Save or export it as M4A or MP3 instead of WAV (an hour of M4A is about 30 MB), or split a long recording into two parts.`
    : `"${file.name}" is ${mb} MB and the limit is ${MAX_UPLOAD_MB} MB.`;
}

/** Uploads straight to storage with a signed URL, so large recordings never pass through the app server. */
export async function uploadFile(projectId: string, file: File): Promise<{ path: string; name: string; size: number; mime: string }> {
  const problem = uploadProblem(file);
  if (problem) throw new ApiError(problem, file.size === 0 ? 400 : 413);
  const { path, token } = await rpc<{ path: string; token: string }>("createUpload", { project_id: projectId, name: file.name });
  const res = await supabase().storage.from("files").uploadToSignedUrl(path, token, file, { contentType: file.type || undefined });
  if (res.error) {
    const big = /exceed|too large|maximum allowed size|413/i.test(res.error.message);
    throw new ApiError(big ? `"${file.name}" is larger than storage allows. Export it as M4A or MP3 and try again.` : `The upload did not finish (${res.error.message}). Check your connection and try again.`, big ? 413 : 500);
  }
  return { path, name: file.name, size: file.size, mime: file.type };
}

export async function openFile(fileId: string, download = false) {
  // Open the tab during the click so popup blockers allow it, then point it at the signed URL.
  const tab = window.open("", "_blank");
  try {
    const { url } = await rpc<{ url: string }>("fileUrl", { file_id: fileId, download });
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.location.href = url;
    }
  } catch (err) {
    tab?.close();
    throw err;
  }
}
