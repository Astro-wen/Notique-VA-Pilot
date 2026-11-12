"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { rpc, supabase } from "@/lib/client/api";
import { homeFor, useSession } from "@/components/Session";
import { Button, Card, ErrorNote, Field, Input, Logo } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const { status, me, refresh, error: sessionError } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ needsSetup: boolean; problem: string | null } | null>(null);

  useEffect(() => {
    if (status === "ready" && me) router.replace(homeFor(me.profile.role));
  }, [status, me, router]);

  useEffect(() => {
    rpc<{ needsSetup: boolean; problem: string | null }>("setupStatus")
      .then(setSetup)
      .catch((err) => setSetup({ needsSetup: false, problem: (err as Error).message }));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await supabase().auth.signInWithPassword({ email: email.trim(), password });
    if (res.error) {
      setError(/invalid/i.test(res.error.message) ? "That email and password do not match. Check both and try again." : res.error.message);
      setBusy(false);
      return;
    }
    await refresh();
    setBusy(false);
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Logo className="mb-6 text-lg" />
        <Card className="p-6">
          <h1 className="text-lg font-semibold">Sign in</h1>
          <p className="mt-1 text-[13px] text-ink-3">Use the email and password your Notique admin gave you.</p>
          {setup?.problem ? <ErrorNote className="mt-4" message={setup.problem} /> : null}
          {setup?.needsSetup ? (
            <div className="mt-4 rounded-lg bg-accent-soft px-3 py-2.5 text-[13px]">
              This workspace has no accounts yet.{" "}
              <Link href="/setup" className="font-medium text-accent underline">
                Create the first admin
              </Link>
            </div>
          ) : null}
          <form onSubmit={submit} className="mt-5 space-y-4">
            <Field label="Email">
              <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error ? <ErrorNote message={error} /> : status === "error" && sessionError ? <ErrorNote message={sessionError} /> : null}
            <Button type="submit" variant="primary" size="lg" className="w-full" busy={busy}>
              Sign in
            </Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-xs text-ink-3">Forgot your password? Ask your admin to reset it.</p>
      </div>
    </main>
  );
}
