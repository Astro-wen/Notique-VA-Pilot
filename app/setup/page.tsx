"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { rpc, supabase } from "@/lib/client/api";
import { useSession } from "@/components/Session";
import { Button, Card, ErrorNote, Field, Input, Logo, Spinner } from "@/components/ui";

export default function SetupPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [state, setState] = useState<{ needsSetup: boolean; problem: string | null } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc<{ needsSetup: boolean; problem: string | null }>("setupStatus")
      .then(setState)
      .catch((err) => setState({ needsSetup: false, problem: (err as Error).message }));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await rpc("setupAdmin", { name, email, password, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      const res = await supabase().auth.signInWithPassword({ email: email.trim(), password });
      if (res.error) throw new Error(res.error.message);
      await refresh();
      router.replace("/admin");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Logo className="mb-6 text-lg" />
        <Card className="p-6">
          <h1 className="text-lg font-semibold">Set up this workspace</h1>
          {!state ? (
            <Spinner />
          ) : state.problem ? (
            <ErrorNote className="mt-4" message={state.problem} />
          ) : !state.needsSetup ? (
            <div className="mt-3 text-[13px] text-ink-2">
              Setup is already complete.{" "}
              <Link href="/login" className="font-medium text-accent underline">
                Sign in
              </Link>
            </div>
          ) : (
            <>
              <p className="mt-1 text-[13px] text-ink-3">Create the first admin account. You will add VAs and users on the next screen.</p>
              <form onSubmit={submit} className="mt-5 space-y-4">
                <Field label="Your name">
                  <Input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
                </Field>
                <Field label="Email">
                  <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
                </Field>
                <Field label="Password" hint="At least 8 characters.">
                  <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                </Field>
                {error ? <ErrorNote message={error} /> : null}
                <Button type="submit" variant="primary" size="lg" className="w-full" busy={busy}>
                  Create admin account
                </Button>
              </form>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}
