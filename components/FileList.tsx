"use client";
import { useEffect, useRef, useState } from "react";
import { Copy, Download, ExternalLink, FileText, Link2, Trash2, Upload } from "lucide-react";
import { openFile, rpc, uploadFile } from "@/lib/client/api";
import { dateTime, fileSize } from "@/lib/client/format";
import type { FileRow } from "@/lib/types";
import { Badge, Button, IconButton, Input, useToast } from "./ui";

export function FileItem({ file, canDelete, onDeleted }: { file: FileRow; canDelete?: boolean; onDeleted?: () => void }) {
  const toast = useToast();
  async function open(download: boolean) {
    try {
      if (file.url) window.open(file.url, "_blank", "noopener");
      else await openFile(file.id, download);
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    }
  }
  async function remove() {
    try {
      await rpc("deleteFile", { file_id: file.id });
      onDeleted?.();
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    }
  }
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-page text-ink-3">{file.url ? <Link2 className="h-4 w-4" /> : <FileText className="h-4 w-4" />}</div>
      <button className="min-w-0 flex-1 text-left" onClick={() => open(false)}>
        <div className="truncate text-sm font-medium text-ink hover:text-accent">{file.name}</div>
        <div className="truncate text-xs text-ink-3">
          {[file.uploaded_by_name, dateTime(file.created_at), fileSize(file.size)].filter(Boolean).join(", ")}
        </div>
        {file.note ? <div className="truncate text-xs text-ink-2">{file.note}</div> : null}
      </button>
      {file.kind === "deliverable" && file.status === "draft" ? <Badge tone="warn">Not sent yet</Badge> : null}
      {file.url ? (
        <IconButton label="Open link" onClick={() => open(false)}>
          <ExternalLink className="h-4 w-4" />
        </IconButton>
      ) : (
        <IconButton label="Download" onClick={() => open(true)}>
          <Download className="h-4 w-4" />
        </IconButton>
      )}
      {canDelete ? (
        <IconButton label="Remove" onClick={remove}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      ) : null}
    </div>
  );
}

/** Upload a file or attach a link. */
export function AddFile({ projectId, taskId, kind, onAdded, allowLink, label }: { projectId: string; taskId?: string; kind: "project" | "attachment" | "deliverable"; onAdded: () => void; allowLink?: boolean; label?: string }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");

  async function upload(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    try {
      for (const file of Array.from(list).slice(0, 10)) {
        const up = await uploadFile(projectId, file);
        await rpc("addFile", { project_id: projectId, task_id: taskId, kind, name: up.name, path: up.path, size: up.size, mime: up.mime });
      }
      onAdded();
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
      if ((err as { status?: number }).status === 409) onAdded();
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }

  async function addLink() {
    const clean = url.trim();
    // People paste "docs.google.com/..." without the scheme. Add it rather than refuse.
    const withScheme = /^https?:\/\//i.test(clean) ? clean : /^[\w-]+(\.[\w-]+)+(\/|$)/.test(clean) ? `https://${clean}` : null;
    if (!withScheme) return toast("That does not look like a link. Paste the full address, for example docs.google.com/...", { tone: "error" });
    setBusy(true);
    try {
      await rpc("addFile", { project_id: projectId, task_id: taskId, kind, name: name.trim() || withScheme.replace(/^https?:\/\//, "").slice(0, 60), url: withScheme });
      setUrl("");
      setName("");
      setLinkOpen(false);
      onAdded();
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
      if ((err as { status?: number }).status === 409) onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <input ref={ref} type="file" hidden multiple onChange={(e) => upload(e.target.files)} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={<Upload className="h-3.5 w-3.5" />} busy={busy} onClick={() => ref.current?.click()}>
          {label ?? "Upload file"}
        </Button>
        {allowLink ? (
          <Button size="sm" icon={<Link2 className="h-3.5 w-3.5" />} onClick={() => setLinkOpen((v) => !v)}>
            Add link
          </Button>
        ) : null}
      </div>
      {linkOpen ? (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Input aria-label="Link" placeholder="https://docs.google.com/..." value={url} onChange={(e) => setUrl(e.target.value)} />
          <Input aria-label="Name" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} className="sm:max-w-48" />
          <Button size="sm" variant="primary" className="!h-9" onClick={addLink} busy={busy}>
            Add
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** True for a short text file that reads better on screen than as a download. */
export function isShortText(file: FileRow): boolean {
  if (file.url || !file.path) return false;
  const text = (file.mime ?? "").startsWith("text/") || /\.(txt|md)$/i.test(file.name);
  return text && (file.size ?? 0) <= 100 * 1024;
}

/** Shows a delivered text draft in place, with one tap to copy it into an email or a text message. */
export function TextPreview({ file }: { file: FileRow }) {
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    rpc<{ url: string }>("fileUrl", { file_id: file.id })
      .then(({ url }) => fetch(url))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => live && setText(t))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [file.id]);
  async function copy() {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied. Paste it into your email or message.");
      return;
    } catch {
      /* Some browsers only allow the older copy command. */
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    if (ok) return toast("Copied. Paste it into your email or message.");
    // Last resort: select the text on screen so the phone's own Copy menu works.
    const node = box.current;
    if (node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    toast("The text is selected. Use Copy from your phone's menu.");
  }
  if (failed) return null;
  return (
    <div className="rounded-lg border border-line bg-white">
      <div ref={box} className="max-h-72 select-text overflow-y-auto whitespace-pre-wrap px-3 py-2.5 text-[13px] leading-relaxed text-ink">{text ?? "Loading the text..."}</div>
      <div className="flex justify-end border-t border-line px-2 py-1.5">
        <Button size="sm" icon={<Copy className="h-3.5 w-3.5" />} disabled={text === null} onClick={copy}>
          Copy text
        </Button>
      </div>
    </div>
  );
}
