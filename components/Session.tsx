"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { rpc, supabase, ApiError } from "@/lib/client/api";
import type { MeResult, Role } from "@/lib/types";
import { Button, ErrorNote, Logo, Spinner } from "./ui";

interface SessionState {
  status: "loading" | "anon" | "ready" | "error";
  me: MeResult | null;
  error: string | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState>({ status: "loading", me: null, error: null, refresh: async () => {}, signOut: async () => {} });

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SessionState["status"]>("loading");
  const [me, setMe] = useState<MeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const session = (await supabase().auth.getSession()).data.session;
    if (!session) {
      setMe(null);
      setStatus("anon");
      return;
    }
    try {
      const result = await rpc<MeResult>("me");
      setMe(result);
      setError(null);
      setStatus("ready");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError(err.message);
        setMe(null);
        setStatus("error");
        return;
      }
      setError((err as Error).message);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    refresh();
    const sub = supabase().auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setMe(null);
        setStatus("anon");
      }
    });
    return () => sub.data.subscription.unsubscribe();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await supabase().auth.signOut();
    setMe(null);
    setStatus("anon");
  }, []);

  return <SessionContext.Provider value={{ status, me, error, refresh, signOut }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}

export function homeFor(role: Role): string {
  return role === "agent" ? "/agent" : "/va";
}

/** Renders children only for signed-in users with one of the given roles. */
export function Authed({ roles, children }: { roles: Role[]; children: React.ReactNode }) {
  const { status, me, error, refresh, signOut } = useSession();
  const router = useRouter();
  const role = me?.profile.role;
  const allowed = !!role && roles.includes(role);

  useEffect(() => {
    if (status === "anon") router.replace("/login");
    else if (status === "ready" && role && !allowed) router.replace(homeFor(role));
  }, [status, role, allowed, router]);

  if (status === "error") {
    return (
      <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-6">
        <Logo />
        <ErrorNote message={error ?? "We could not load your account."} />
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => refresh()}>
            Try again
          </Button>
          <Button onClick={() => signOut()}>Sign out</Button>
        </div>
      </div>
    );
  }
  if (status !== "ready" || !allowed) return <Spinner />;
  return <>{children}</>;
}
