"use client";
import { useEffect, useState } from "react";

const BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";

/**
 * A tab left open for days keeps running the code it loaded. When a newer version is live, offer a
 * reload instead of doing it, so nothing being typed is lost.
 */
export function UpdateNotice() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (BUILD === "dev") return;
    let stop = false;
    const check = () => {
      if (stop || document.visibilityState !== "visible") return;
      fetch("/api/version", { cache: "no-store" })
        .then((r) => r.json())
        .then((d: { version?: string }) => {
          if (!stop && d.version && d.version !== "dev" && d.version !== BUILD) setStale(true);
        })
        .catch(() => {});
    };
    check();
    const id = window.setInterval(check, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", check);
    return () => {
      stop = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  if (!stale) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-[70] flex items-center justify-center gap-3 bg-ink px-4 py-2 text-[13px] text-white">
      <span>Notique was updated.</span>
      <button className="font-semibold underline underline-offset-2" onClick={() => window.location.reload()}>
        Reload to get the latest version
      </button>
    </div>
  );
}
