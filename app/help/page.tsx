"use client";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Authed, homeFor, useSession } from "@/components/Session";
import { TOUR_STEPS } from "@/components/Tour";
import { Button, Card, Logo } from "@/components/ui";

const FAQ: Record<"va" | "agent", [string, string][]> = {
  va: [
    ["What is the difference between Decline and Insufficient?", "Decline means the AI got it wrong, so the item is thrown away. Insufficient means it might be true but the transcript does not prove it. Those are held under Needs agent input on the project and the agent never sees them as facts."],
    ["Why can I not approve a low confidence item?", "Items under 60% must be edited, declined, or marked insufficient. Rewording it yourself confirms you checked it against the quote."],
    ["The recording has no consent notice. What now?", "Do not submit. Choose Escalate and pick No recording consent heard. Nothing from the event reaches the agent."],
    ["The agent answered me by text instead of in the app.", "Open the ticket, switch the message box to Log agent reply, pick the channel, and paste what they said. The ticket leaves Waiting on agent on its own."],
    ["When is an event due?", "9:00 AM on the next business day in the agent's time zone. The queue sorts by that deadline."],
    ["Can I contact the agent's client or a lender?", "No. You research and draft. The agent decides what goes out and sends it."],
  ],
  agent: [
    ["What can I upload?", "A meeting or call recording, a transcript file, screenshots of a text thread, or a note you type after a meeting. Each one goes into a client's project."],
    ["When will I see results?", "By 9:00 AM the next business day in your time zone. The Deal status tab shows a notice while a conversation is being verified."],
    ["Does my assistant contact my clients?", "Never. They only prepare research and drafts for you. Review every deliverable before you send anything."],
    ["How do I change a task after assigning it?", "You can edit it until work starts. After that, open the task and send a message."],
    ["What does Ask for changes do?", "It sends the task back to your assistant with your note and it returns to In progress."],
  ],
};

function Help() {
  const router = useRouter();
  const { me } = useSession();
  const role = me?.profile.role === "agent" ? "agent" : "va";
  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center gap-3 border-b border-line bg-white px-4">
        <Logo />
        <Button size="sm" className="ml-auto" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => router.push(homeFor(me?.profile.role ?? "agent"))}>
          Back to work
        </Button>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="text-xl font-semibold">Help</h1>
        <h2 className="mt-6 text-[15px] font-semibold">How it works</h2>
        <ol className="mt-3 space-y-2">
          {TOUR_STEPS[role].map((s, i) => (
            <li key={s.title}>
              <Card className="flex gap-3 p-4">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-semibold text-white">{i + 1}</span>
                <div>
                  <div className="font-medium">{s.title}</div>
                  <p className="mt-0.5 text-[13px] text-ink-2">{s.body}</p>
                </div>
              </Card>
            </li>
          ))}
        </ol>
        <h2 className="mt-8 text-[15px] font-semibold">Common questions</h2>
        <div className="mt-3 space-y-2">
          {FAQ[role].map(([q, a]) => (
            <details key={q} className="rounded-xl border border-line bg-white px-4 py-3">
              <summary className="font-medium">{q}</summary>
              <p className="mt-2 text-[13px] text-ink-2">{a}</p>
            </details>
          ))}
        </div>
      </main>
    </div>
  );
}

export default function HelpPage() {
  return (
    <Authed roles={["admin", "va", "agent"]}>
      <Help />
    </Authed>
  );
}
