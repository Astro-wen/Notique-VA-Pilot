"use client";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Authed, homeFor, useSession } from "@/components/Session";
import { HowItWorks } from "@/components/HowItWorks";
import { Button, Logo } from "@/components/ui";

function How() {
  const router = useRouter();
  const { me } = useSession();
  const role = me?.profile.role ?? "agent";
  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center gap-3 border-b border-line bg-white px-4">
        <Logo />
        <Button size="sm" className="ml-auto" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => router.push(homeFor(role))}>
          Back to work
        </Button>
      </header>
      <main className="mx-auto max-w-[1500px] px-4 py-6">
        <h1 className="text-xl font-semibold">How Notique works</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-2">One conversation goes in at step 1. A finished follow-up comes out at step 6. AI does the first pass at each step, a human assistant checks it, and the user is only asked for a tap.</p>
        <div className="mt-5">
          <HowItWorks role={role} />
        </div>
      </main>
    </div>
  );
}

export default function HowPage() {
  return (
    <Authed roles={["admin", "va", "agent"]}>
      <How />
    </Authed>
  );
}
