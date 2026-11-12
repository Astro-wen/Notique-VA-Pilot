"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { BadgeCheck } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { SOURCE_LABEL, dateOnly, dateTime, projectLine } from "@/lib/client/format";
import type { ShareView } from "@/lib/types";
import { DealFacts } from "@/components/DealFacts";
import { Card, Empty, Logo, Spinner, useLoad } from "@/components/ui";

function Shared() {
  const token = useSearchParams().get("t") ?? "";
  const { data, error, loading } = useLoad(() => rpc<ShareView>("shareView", { token }), [token]);
  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center justify-between border-b border-line bg-white px-4">
        <Logo />
        <span className="text-xs text-ink-3">Read only</span>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-6">
        {loading && !data ? <Spinner /> : null}
        {error && !data ? (
          <Card>
            <Empty title="This link is not available" body={error} />
          </Card>
        ) : null}
        {data ? (
          <>
            <h1 className="text-xl font-semibold">{data.project.client_name}</h1>
            <p className="text-[13px] text-ink-3">{projectLine(data.project)}</p>
            {data.lastVerified ? (
              <div className="mt-4 flex items-center gap-2 rounded-xl bg-ok-soft px-3.5 py-2.5 text-[13px] text-ok">
                <BadgeCheck className="h-4 w-4" />
                Verified by {data.lastVerified.by.split(" ")[0]}, {dateTime(data.lastVerified.at)}
              </div>
            ) : null}
            <div className="mt-4">{data.facts.length ? <DealFacts facts={data.facts} /> : <Card><Empty title="No verified facts yet" /></Card>}</div>
            {data.events.length ? (
              <Card className="mt-4">
                <h2 className="border-b border-line px-4 py-3 text-[15px] font-semibold">Conversations</h2>
                <ul className="divide-y divide-line">
                  {data.events.map((e) => (
                    <li key={e.id} className="px-4 py-2.5">
                      <div className="text-sm font-medium">{e.title}</div>
                      <div className="text-xs text-ink-3">
                        {SOURCE_LABEL[e.source]}, {dateOnly(e.occurred_at)}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
            <p className="mt-6 text-center text-xs text-ink-3">Prepared for {data.agentName}. This link stops working on {dateOnly(data.expires_at)}.</p>
          </>
        ) : null}
      </main>
    </div>
  );
}

export default function SharePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Shared />
    </Suspense>
  );
}
