"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CircleHelp, GraduationCap, LogOut, Settings2 } from "lucide-react";
import { useSession } from "./Session";
import { Tour } from "./Tour";

export function UserMenu() {
  const { me, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const [tour, setTour] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const profile = me?.profile;

  useEffect(() => {
    if (profile && !profile.onboarded_at) setTour(true);
  }, [profile?.id, profile?.onboarded_at]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  if (!profile) return null;
  const initials = profile.name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const item = "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-ink-2 hover:bg-page";
  return (
    <div ref={ref} className="relative">
      <button aria-label="Account menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-xs font-semibold text-white">
        {initials || "N"}
      </button>
      {open ? (
        <div className="rise absolute right-0 top-10 z-40 w-60 rounded-xl border border-line bg-white p-2 shadow-lg">
          <div className="border-b border-line px-2 pb-2">
            <div className="truncate text-sm font-semibold">{profile.name}</div>
            <div className="truncate text-xs text-ink-3">{profile.email}</div>
          </div>
          <div className="pt-2">
            <button
              className={item}
              onClick={() => {
                setOpen(false);
                setTour(true);
              }}
            >
              <GraduationCap className="h-4 w-4" /> Replay tutorial
            </button>
            <Link className={item} href="/help" onClick={() => setOpen(false)}>
              <CircleHelp className="h-4 w-4" /> Help
            </Link>
            {profile.role === "admin" ? (
              <Link className={item} href="/admin" onClick={() => setOpen(false)}>
                <Settings2 className="h-4 w-4" /> Admin
              </Link>
            ) : null}
            <button className={item} onClick={() => signOut()}>
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        </div>
      ) : null}
      <Tour open={tour} onClose={() => setTour(false)} />
    </div>
  );
}
