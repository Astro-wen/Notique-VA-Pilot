"use client";
import { useEffect, useRef, useState } from "react";
import { FileAudio, FileText, MessageSquareText, NotebookPen, Paperclip, Upload } from "lucide-react";
import { rpc, uploadFile } from "@/lib/client/api";
import { toLocalInput } from "@/lib/client/format";
import type { EventRow, EventSource, Project } from "@/lib/types";
import { Button, ErrorNote, Field, Input, Modal, Select, Textarea, cx } from "./ui";

export type AddKind = "audio" | "transcript" | "texts" | "note" | "files";

const KINDS: { key: AddKind; label: string; hint: string; icon: React.ReactNode }[] = [
  { key: "audio", label: "Recording", hint: "Audio or video of a meeting, call, or voice memo", icon: <FileAudio className="h-4 w-4" /> },
  { key: "transcript", label: "Transcript", hint: "A .vtt, .txt, or .docx file, or pasted text", icon: <FileText className="h-4 w-4" /> },
  { key: "texts", label: "Text messages", hint: "Screenshots or a pasted thread", icon: <MessageSquareText className="h-4 w-4" /> },
  { key: "note", label: "Written note", hint: "A debrief or CRM note typed after the fact", icon: <NotebookPen className="h-4 w-4" /> },
  { key: "files", label: "Photos, files", hint: "Showing schedules, listing sheets, flyers, anything kept for reference. Stored on the project as is. The AI does not read these.", icon: <Paperclip className="h-4 w-4" /> },
];

const ACCEPT: Record<AddKind, string> = {
  audio: "audio/*,video/*,.mp3,.m4a,.wav,.mp4,.mov,.aac,.ogg,.webm,.flac",
  transcript: ".vtt,.txt,.docx,.srt,.md",
  texts: "image/*",
  note: "",
  files: "",
};

interface Props {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  agentId?: string;
  defaultProjectId?: string;
  defaultKind?: AddKind;
  onCreated: (event: EventRow) => void;
  onProjectCreated?: (project: Project) => void;
  /** Dialog heading. The user side calls this adding material. */
  heading?: string;
  /** Called after reference files were stored on a project. */
  onFilesAdded?: (projectId: string, count: number) => void;
}

export function AddEventDialog({ open, onClose, projects, agentId, defaultProjectId, defaultKind, onCreated, onProjectCreated, heading, onFilesAdded }: Props) {
  const [kind, setKind] = useState<AddKind>(defaultKind ?? "audio");
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [newClient, setNewClient] = useState("");
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState(toLocalInput(null));
  const [memo, setMemo] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setKind(defaultKind ?? "audio");
    setProjectId(defaultProjectId ?? (projects.length === 1 ? projects[0].id : projects.length === 0 ? "new" : ""));
    setNewClient("");
    setTitle("");
    setWhen(toLocalInput(null));
    setMemo(false);
    setFiles([]);
    setText("");
    setBusy(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function pick(list: FileList | null) {
    if (!list) return;
    const next = Array.from(list);
    setFiles(kind === "texts" ? next.slice(0, 8) : kind === "files" ? next.slice(0, 10) : next.slice(0, 1));
    if (kind !== "files" && !title && next[0]) setTitle(next[0].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 80));
  }

  async function submit() {
    setError(null);
    if (!projectId) return setError("Choose a project.");
    if (projectId === "new" && !newClient.trim()) return setError("Enter the client name for the new project.");
    if (kind === "files") {
      if (files.length === 0) return setError("Choose at least one photo or file.");
      try {
        let pid = projectId;
        if (pid === "new") {
          setBusy("Creating the project");
          const project = await rpc<Project>("createProject", { agent_id: agentId, client_name: newClient.trim() });
          onProjectCreated?.(project);
          pid = project.id;
          setProjectId(pid);
        }
        for (let i = 0; i < files.length; i += 1) {
          setBusy(`Uploading ${i + 1} of ${files.length}`);
          const up = await uploadFile(pid, files[i]);
          await rpc("addFile", { project_id: pid, kind: "project", name: up.name, path: up.path, size: up.size, mime: up.mime, note: title.trim() || undefined });
        }
        onFilesAdded?.(pid, files.length);
        onClose();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
      return;
    }
    if (!title.trim()) return setError("Give this a short title, for example Second showing recap.");
    if (!when || Number.isNaN(new Date(when).getTime())) return setError("Enter when the conversation happened.");
    if (new Date(when).getTime() > Date.now() + 5 * 60000) return setError("The conversation time cannot be in the future.");
    if (kind === "audio" && files.length === 0) return setError("Choose a recording to upload.");
    if (kind !== "audio" && files.length === 0 && text.trim().length < 20) return setError(kind === "texts" ? "Add screenshots or paste the thread." : "Add a file or paste the text.");
    try {
      let pid = projectId;
      if (pid === "new") {
        setBusy("Creating the project");
        const project = await rpc<Project>("createProject", { agent_id: agentId, client_name: newClient.trim() });
        onProjectCreated?.(project);
        pid = project.id;
        setProjectId(pid);
      }
      const source: EventSource = kind === "audio" ? (memo ? "voice_memo" : "recording") : kind === "transcript" ? "transcript_upload" : kind === "texts" ? "text_upload" : "note";
      const args: Record<string, unknown> = {
        project_id: pid,
        title: title.trim(),
        source,
        event_type: kind === "audio" ? (memo ? "debrief" : "meeting") : kind === "texts" ? "messages" : kind === "note" ? "note" : "meeting",
        occurred_at: new Date(when).toISOString(),
      };
      if (files.length) {
        const uploaded = [];
        for (let i = 0; i < files.length; i += 1) {
          setBusy(files.length > 1 ? `Uploading ${i + 1} of ${files.length}` : "Uploading");
          uploaded.push(await uploadFile(pid, files[i]));
        }
        if (kind === "audio") args.audio_path = uploaded[0].path;
        else if (kind === "texts") args.image_paths = uploaded.map((u) => u.path);
        else args.file_path = uploaded[0].path;
        args.file_name = uploaded[0].name;
      } else {
        args.text = text;
      }
      setBusy(kind === "audio" ? "Starting transcription" : "Reading the text and drafting facts. This can take a minute");
      const event = await rpc<EventRow>("createEvent", args);
      onCreated(event);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const current = KINDS.find((k) => k.key === kind)!;
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={heading ?? "Add a conversation"}
      wide
      footer={
        <>
          {busy ? <span className="mr-auto text-[13px] text-ink-3">{busy}</span> : null}
          <Button onClick={onClose} disabled={!!busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} busy={!!busy}>
            {kind === "files" ? "Add to project" : heading ? "Send for verification" : "Add to queue"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" role="radiogroup" aria-label="Source type">
          {KINDS.map((k) => (
            <button
              key={k.key}
              role="radio"
              aria-checked={kind === k.key}
              onClick={() => {
                setKind(k.key);
                setFiles([]);
                setError(null);
              }}
              className={cx("flex h-11 items-center justify-center gap-1.5 rounded-lg border px-1 text-[13px] font-medium leading-tight", kind === k.key ? "border-accent bg-accent-soft text-[#2f55cc]" : "border-line text-ink-2 hover:bg-page")}
            >
              {k.icon}
              {k.label}
            </button>
          ))}
        </div>
        <p className="text-[13px] text-ink-3">{current.hint}</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Project">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="" disabled>
                Choose a project
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.client_name}
                </option>
              ))}
              <option value="new">New project</option>
            </Select>
          </Field>
          {projectId === "new" ? (
            <Field label="Client name">
              <Input value={newClient} onChange={(e) => setNewClient(e.target.value)} placeholder="Michael and Jenny Chen" />
            </Field>
          ) : null}
          {kind === "files" ? (
            <Field label="Note" hint="Optional, for example Saturday showing schedule.">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
            </Field>
          ) : (
            <>
              <Field label="Title">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Second showing recap" maxLength={120} />
              </Field>
              <Field label="When it happened">
                <Input type="datetime-local" value={when} max={toLocalInput(null)} onChange={(e) => setWhen(e.target.value)} />
              </Field>
            </>
          )}
        </div>

        {kind !== "note" ? (
          <div>
            <input ref={fileRef} type="file" hidden accept={ACCEPT[kind]} multiple={kind === "texts" || kind === "files"} onChange={(e) => pick(e.target.files)} />
            <button
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                pick(e.dataTransfer.files);
              }}
              className="flex w-full flex-col items-center gap-1 rounded-lg border border-dashed border-line-strong bg-page px-4 py-6 text-[13px] text-ink-2 hover:bg-[#eceef1]"
            >
              <Upload className="h-5 w-5 text-ink-3" />
              {files.length ? (
                <span className="font-medium text-ink">{files.map((f) => f.name).join(", ")}</span>
              ) : (
                <span>
                  <span className="font-medium text-ink">Choose {kind === "texts" ? "screenshots" : kind === "files" ? "photos or files" : "a file"}</span> or drop here
                </span>
              )}
              <span className="text-xs text-ink-3">{kind === "audio" ? "MP3, M4A, WAV, MP4 up to 500 MB" : kind === "transcript" ? "VTT, TXT, or DOCX" : kind === "files" ? "Up to 10 at a time. Your assistant sees them on the project" : "Up to 8 images of a text thread. The AI reads these"}</span>
            </button>
          </div>
        ) : null}

        {kind === "audio" ? (
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            <input type="checkbox" className="h-4 w-4 accent-[#0d0d0d]" checked={memo} onChange={(e) => setMemo(e.target.checked)} />
            This is the user talking alone after the meeting (voice memo)
          </label>
        ) : kind === "files" ? null : files.length === 0 ? (
          <Field label={kind === "note" ? "Note" : "Or paste the text"}>
            <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === "texts" ? "Michael: Can we see the Maple St house again Saturday?" : "Paste the full text here"} />
          </Field>
        ) : null}

        {error ? <ErrorNote message={error} /> : null}
      </div>
    </Modal>
  );
}
