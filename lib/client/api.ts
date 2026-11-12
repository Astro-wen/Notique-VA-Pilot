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

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/** Uploads straight to storage with a signed URL, so large recordings never pass through the app server. */
export async function uploadFile(projectId: string, file: File): Promise<{ path: string; name: string; size: number; mime: string }> {
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError("This file is larger than 500 MB. Trim or compress it and try again.", 413);
  if (file.size === 0) throw new ApiError("This file is empty.", 400);
  const { path, token } = await rpc<{ path: string; token: string }>("createUpload", { project_id: projectId, name: file.name });
  const res = await supabase().storage.from("files").uploadToSignedUrl(path, token, file, { contentType: file.type || undefined });
  if (res.error) throw new ApiError(`Upload failed: ${res.error.message}`, 500);
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
