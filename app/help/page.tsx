"use client";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Authed, homeFor, useSession } from "@/components/Session";
import { Button, Card, Logo } from "@/components/ui";

type HelpRole = "va" | "agent" | "admin";

const STEPS: Record<HelpRole, { title: string; body: string }[]> = {
  agent: [
    { title: "Add a conversation", body: "After a meeting, tap Add conversation and add the recording, a transcript, screenshots of a text thread, or a written note. Choose the client it belongs to." },
    { title: "Your assistant verifies it", body: "A person checks every fact against what was actually said. Results show under Deal status by 9:00 AM the next business day. Until then you see a notice that it is being verified." },
    { title: "Read what changed", body: "Deal status lists decisions, budget, client needs, open questions, risks and next steps. Tap the source under any line to read the exact quote. Anything that needs you is at the top under Waiting on you." },
    { title: "Send the follow-up work", body: "The Requests tab suggests work after each conversation. Tap Send on the ones you want, edit them first, or write your own with Submit a request." },
    { title: "Review and send it yourself", body: "When something is delivered, open it, send it to your client yourself, and say whether you used it. Ask for changes sends it back. Your assistant never contacts your clients." },
  ],
  va: [
    { title: "Check who you are serving", body: "The name at the top right is the user whose work you see. Switch there when you work for someone else." },
    { title: "Verify the queue", body: "Open Queue and click Verify on the top row. Decide on every AI draft: Approve, Edit, Decline, or Ask user. Tick the four checks, then Submit. Due 9:00 AM the next business day in the user's time zone." },
    { title: "Mark what was settled", body: "Before you submit, if the client has earlier open items, a list appears under the drafts: earlier open questions, concerns and next steps. Tick the ones this conversation answered so the user's deal profile stays current." },
    { title: "Work the tickets", body: "Open Tickets. Set an ETA on anything marked Received. Finish the AI first draft, save it to Deliverables, then Mark delivered. The user calls tickets requests." },
    { title: "Check in once a day", body: "Open Check-in, edit the ready message, send it to the user, and mark it done. When the user says yes to something, press the button on that item so it becomes a ticket." },
    { title: "Watch the market for a client", body: "On a project, open Watches and write a condition such as a mortgage rate or a listing price. Notique checks it every day and opens a ticket when it becomes true." },
    { title: "One rule", body: "You never contact the user's clients or any third party. You research and draft. The user sends." },
  ],
  admin: [
    { title: "Add people", body: "Click Add person. Create one account for each VA and each user (the real estate agent). Pick the user's time zone carefully: their 9:00 AM deadlines follow it." },
    { title: "Match them", body: "Under Who serves whom, tick the box where the VA's row meets the user's column. Without this the VA sees nothing and the user has no assistant." },
    { title: "Send the login details yourself", body: "Give each person the sign-in address, their email and the temporary password. Notique does not email them." },
    { title: "Check it worked", body: "Click Open VA Console. The user should appear in the Serving user menu at the top." },
  ],
};

const FAQ: Record<HelpRole, [string, string][]> = {
  va: [
    ["What is the difference between Decline and Ask user?", "Decline means the AI got it wrong, so the item is thrown away. Ask user means it might be true but the transcript does not prove it. Those are held under Waiting for the user to confirm on the project, and the user never sees them as facts."],
    ["Why is there no Approve button on some items?", "Two reasons. The AI was not sure about the item, or the wording describes a person instead of the property (family, age, religion, disability, military service). Use Edit and approve: read the quote, rewrite it as a property requirement such as \"needs four bedrooms\", and save. Decline it if it has no property meaning."],
    ["The recording has no consent notice. What now?", "Do not submit. Choose Escalate and pick No recording consent heard. Nothing from the conversation reaches the user."],
    ["The user answered me by text instead of in the app.", "Open the ticket, switch the message box to Log what they said, pick the channel, and paste what they said. The ticket leaves Waiting on user on its own."],
    ["The user asked for something by text, email or phone.", "Open Tickets and click Log a request from the user. Choose the client, describe what they asked, pick how they asked, and attach a screenshot if you have one. It is tracked like any other request and the deadline counts."],
    ["Can I send the AI first draft as it is?", "No. It is a starting point. Fill in every [ADD: ...], check each fact against the deal profile, and save your version to Deliverables."],
    ["When is a conversation due?", "9:00 AM on the next business day in the user's time zone. The queue sorts by that deadline."],
    ["Can I contact the user's client or a lender?", "No. You research and draft. The user decides what goes out and sends it."],
  ],
  agent: [
    ["What can I add?", "A meeting or call recording, a transcript file, screenshots of a text thread, or a note you type after a meeting. You can also store reference files such as a showing schedule. Those are kept for your assistant and not turned into facts."],
    ["When will I see results?", "By 9:00 AM the next business day in your time zone. Deal status shows a notice while a conversation is being verified."],
    ["What does Verified mean?", "Your assistant checked that line against the recording or text. Tap the source under it to read the exact quote."],
    ["Does my assistant contact my clients?", "Never. They only prepare research and drafts for you. Review every delivery before you send anything."],
    ["How do I change a request after sending it?", "You can edit it until work starts. After that, open the request and send a message."],
    ["What does Ask for changes do?", "It sends the delivery back to your assistant with your note."],
  ],
  admin: [
    ["A VA says they see No users assigned yet.", "Tick a box for them under Who serves whom."],
    ["How do I turn on emails or texts to a user?", "Click the pencil next to the user's name. Under Reaching this user, add their mobile number and choose what they get. Only do this after they agreed."],
    ["Why can I not delete an account?", "A user with projects cannot be deleted because that would delete their client data. A VA with work history cannot be deleted either. Reset the password to cut off access."],
    ["Someone forgot their password.", "Click Reset password on their row, set a new one, and send it to them yourself."],
  ],
};

function Help() {
  const router = useRouter();
  const { me } = useSession();
  const mine: HelpRole = me?.profile.role === "agent" ? "agent" : me?.profile.role === "admin" ? "admin" : "va";
  const sections: HelpRole[] = mine === "admin" ? ["admin", "va"] : [mine];
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
        {sections.map((role) => (
          <section key={role}>
            <h2 className="mt-6 text-[15px] font-semibold">{sections.length > 1 ? (role === "admin" ? "Setting up, for admins" : "Working as a VA") : "How it works"}</h2>
            <ol className="mt-3 space-y-2">
              {STEPS[role].map((s, i) => (
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
          </section>
        ))}
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
