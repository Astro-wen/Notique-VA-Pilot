"use client";
import { useRef, useState } from "react";
import { Download, ExternalLink, FileText, Link2, Trash2, Upload } from "lucide-react";
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
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }

  async function addLink() {
    const clean = url.trim();
    if (!/^https?:\/\//i.test(clean)) return toast("Links must start with http or https.", { tone: "error" });
    setBusy(true);
    try {
      await rpc("addFile", { project_id: projectId, task_id: taskId, kind, name: name.trim() || clean.replace(/^https?:\/\//, "").slice(0, 60), url: clean });
      setUrl("");
      setName("");
      setLinkOpen(false);
      onAdded();
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
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
