"use client";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Loader2, X } from "lucide-react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ---------- Button ---------- */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost" | "danger" | "link";
  size?: "sm" | "md" | "lg";
  busy?: boolean;
  icon?: React.ReactNode;
};

export function Button({ variant = "outline", size = "md", busy, icon, className, children, disabled, type, ...rest }: ButtonProps) {
  const base = "inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors disabled:opacity-50 select-none";
  const sizes = { sm: "h-8 px-3 text-[13px] rounded-md", md: "h-9 px-4 text-sm rounded-md", lg: "h-11 px-6 text-sm rounded-md" }[size];
  const variants = {
    primary: "bg-ink text-white hover:bg-[#2a2a2a]",
    outline: "bg-white text-ink border border-line-strong hover:bg-[#f7f7f7]",
    ghost: "text-ink-2 hover:bg-black/5",
    danger: "bg-white text-bad border border-[#e2a9a3] hover:bg-bad-soft",
    link: "text-accent hover:underline !h-auto !px-0",
  }[variant];
  return (
    <button type={type ?? "button"} className={cx(base, sizes, variants, className)} disabled={disabled || busy} {...rest}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} className={cx("inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-3 hover:bg-black/5 hover:text-ink disabled:opacity-40", className)} {...rest}>
      {children}
    </button>
  );
}

/* ---------- Badge ---------- */

export type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "dark";

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  const tones: Record<Tone, string> = {
    neutral: "bg-[#eef0f2] text-ink-2",
    accent: "bg-accent-soft text-[#2f55cc]",
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    bad: "bg-bad-soft text-bad",
    dark: "bg-ink text-white",
  };
  return <span className={cx("inline-flex h-[22px] items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap", tones[tone], className)}>{children}</span>;
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-white px-1 font-mono text-[11px] text-ink-3">{children}</kbd>;
}

/* ---------- Layout ---------- */

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("rounded-xl border border-line bg-white", className)} {...rest}>
      {children}
    </div>
  );
}

export function SectionTitle({ children, right, className }: { children: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-center justify-between gap-3", className)}>
      <h2 className="text-[15px] font-semibold">{children}</h2>
      {right}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-ink-3" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function Empty({ icon, title, body, action }: { icon?: React.ReactNode; title: string; body?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {icon ? <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-page text-ink-3">{icon}</div> : null}
      <div className="font-semibold">{title}</div>
      {body ? <div className="mt-1 max-w-sm text-[13px] text-ink-3">{body}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cx("flex items-start gap-2 rounded-lg border border-[#f0c4bf] bg-bad-soft px-3 py-2.5 text-[13px] text-bad", className)}>
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="flex-1">{message}</div>
      {onRetry ? (
        <button className="font-medium underline" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/* ---------- Form ---------- */

const inputBase = "w-full rounded-md border border-[#cfd3d8] bg-white px-3 text-sm placeholder:text-[#9aa0a6] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:bg-page";

export function Field({ label, hint, error, children, className }: { label: string; hint?: string; error?: string | null; children: React.ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-bad">{error}</span> : hint ? <span className="mt-1 block text-xs text-ink-3">{hint}</span> : null}
    </label>
  );
}

export function Input({ className, ...rest }: React.ComponentProps<"input">) {
  return <input className={cx(inputBase, "h-9", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(inputBase, "py-2 leading-relaxed", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(inputBase, "h-9 pr-8", className)} {...rest}>
      {children}
    </select>
  );
}

/* ---------- Tabs ---------- */

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { key: T; label: string; count?: number; tour?: string }[]; value: T; onChange: (key: T) => void; className?: string }) {
  return (
    <div role="tablist" className={cx("flex gap-5 overflow-x-auto border-b border-line", className)}>
      {tabs.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            role="tab"
            data-tour={t.tour}
            aria-selected={active}
            onClick={() => onChange(t.key)}
            className={cx("-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 text-sm", active ? "border-ink font-semibold text-ink" : "border-transparent text-ink-3 hover:text-ink")}
          >
            {t.label}
            {typeof t.count === "number" && t.count > 0 ? <span className={cx("rounded-full px-1.5 text-xs", active ? "bg-ink text-white" : "bg-[#e7e9ec] text-ink-2")}>{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- Modal ---------- */

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const previous = document.activeElement as HTMLElement | null;
    // Focus once when the dialog opens. Never again while the user is typing.
    const first = ref.current?.querySelector<HTMLElement>("input,textarea,select,button[data-autofocus]");
    first?.focus();
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" data-modal onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={cx("rise flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-xl", wide ? "sm:max-w-2xl" : "sm:max-w-md")}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ---------- Toasts ---------- */

interface Toast {
  id: number;
  message: string;
  tone: "info" | "error";
  action?: { label: string; run: () => void };
}

const ToastContext = createContext<(message: string, options?: { tone?: "info" | "error"; action?: Toast["action"] }) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const push = useCallback((message: string, options?: { tone?: "info" | "error"; action?: Toast["action"] }) => {
    const id = ++counter.current;
    setToasts((list) => [...list.slice(-2), { id, message, tone: options?.tone ?? "info", action: options?.action }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), options?.action ? 8000 : options?.tone === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx("rise pointer-events-auto flex max-w-md items-center gap-3 rounded-lg px-4 py-2.5 text-[13px] text-white shadow-lg", t.tone === "error" ? "bg-bad" : "bg-ink")}>
            <span>{t.message}</span>
            {t.action ? (
              <button
                className="font-semibold underline underline-offset-2"
                onClick={() => {
                  t.action?.run();
                  setToasts((list) => list.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/* ---------- Data loading ---------- */

export function useLoad<T>(loader: () => Promise<T>, deps: unknown[], options?: { refreshMs?: number }) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const seq = useRef(0);

  const reload = useCallback(async (quiet = false) => {
    const mine = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const result = await loaderRef.current();
      if (mine !== seq.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      if (!quiet) setError((err as Error).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setData(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!options?.refreshMs) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") reload(true);
    }, options.refreshMs);
    return () => window.clearInterval(id);
  }, [options?.refreshMs, reload]);

  return { data, setData, error, loading, reload };
}

/** Ticks every second so timers re-render. */
export function useNow(active = true, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [active, everyMs]);
  return now;
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-ink text-[13px] font-bold text-white">N</span>
      <span>Notique</span>
    </span>
  );
}
