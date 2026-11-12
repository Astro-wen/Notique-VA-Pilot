"use client";
import { ArrowLeft } from "lucide-react";
import { AgentProject } from "../agent/Project";
import { Button } from "../ui";
import type { VaNav } from "./Console";

export function AgentPreview({ nav, projectId }: { nav: VaNav; projectId: string }) {
  return (
    <div className="mx-auto max-w-md">
      <div className="mb-3 flex items-center justify-between gap-3">
        <Button size="sm" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => nav.go("project", { id: projectId })}>
          Back to project
        </Button>
        <span className="text-xs text-ink-3">This is what {nav.agent.name.split(" ")[0]} sees. Preview only.</span>
      </div>
      <div className="rounded-[28px] border border-line-strong bg-page p-4 shadow-sm">
        <AgentProject projectId={projectId} preview />
      </div>
    </div>
  );
}
