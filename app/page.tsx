"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { homeFor, useSession } from "@/components/Session";
import { Button, ErrorNote, Logo, Spinner } from "@/components/ui";

export default function Home() {
  const { status, me, error, refresh, signOut } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status === "anon") router.replace("/login");
    if (status === "ready" && me) router.replace(homeFor(me.profile.role));
  }, [status, me, router]);
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
  return <Spinner />;
}
