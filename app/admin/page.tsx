"use client";
import { useState } from "react";
import Link from "next/link";
import { KeyRound, Plus } from "lucide-react";
import { rpc } from "@/lib/client/api";
import type { AdminUser } from "@/lib/types";
import { Authed } from "@/components/Session";
import { UserMenu } from "@/components/UserMenu";
import { Coach, TOURS } from "@/components/Coach";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Logo, Modal, Select, Spinner, useLoad, useToast } from "@/components/ui";

const ZONES = ["America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago", "America/New_York", "Pacific/Honolulu", "America/Anchorage", "Asia/Taipei", "Asia/Manila"];
const ROLE_LABEL = { admin: "Admin", va: "VA", agent: "User" } as const;

function AdminPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => rpc<AdminUser[]>("adminListUsers"), []);
  const [create, setCreate] = useState(false);
  const [reset, setReset] = useState<AdminUser | null>(null);
  const [form, setForm] = useState({ name: "", email: "", role: "agent", company: "", timezone: "America/Los_Angeles", password: "" });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const users = data ?? [];
  const agents = users.filter((u) => u.role === "agent");
  const vas = users.filter((u) => u.role === "va");

  async function createUser() {
    if (!form.name.trim() || !form.email.trim()) return toast("Enter a name and an email.", { tone: "error" });
    if (form.password.length < 8) return toast("The temporary password needs at least 8 characters.", { tone: "error" });
    setBusy(true);
    try {
      await rpc("adminCreateUser", form);
      toast(`Account created. Send ${form.name.split(" ")[0]} the sign-in address, their email, and the temporary password.`);
      setCreate(false);
      setForm({ name: "", email: "", role: "agent", company: "", timezone: "America/Los_Angeles", password: "" });
      reload(true);
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (!reset) return;
    if (password.length < 8) return toast("The new password needs at least 8 characters.", { tone: "error" });
    setBusy(true);
    try {
      await rpc("adminResetPassword", { user_id: reset.id, password });
      toast("Password changed. Share the new one with them directly.");
      setReset(null);
      setPassword("");
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(va: AdminUser, agentId: string, on: boolean) {
    try {
      await rpc("adminSetAssignment", { va_id: va.id, agent_id: agentId, on });
      reload(true);
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    }
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-white px-4">
        <Link href="/va" aria-label="VA Console">
          <Logo />
        </Link>
        <span className="rounded-md bg-page px-2 py-0.5 text-xs font-medium text-ink-2">Admin</span>
        <Link href="/va" className="ml-auto text-[13px] text-accent hover:underline">
          Open VA Console
        </Link>
        <UserMenu />
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">People</h1>
            <p className="mt-0.5 text-[13px] text-ink-3">Create accounts, then choose which users each VA serves.</p>
          </div>
          <Button data-tour="admin-add" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreate(true)}>
            Add person
          </Button>
        </div>
        {error && !data ? <ErrorNote className="mt-4" message={error} onRetry={() => reload()} /> : null}
        {loading && !data ? <Spinner /> : null}

        {data ? (
          <>
            <Card className="mt-5 overflow-hidden">
              <ul className="divide-y divide-line">
                {users.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{u.name}</div>
                      <div className="truncate text-xs text-ink-3">{[u.email, u.company, u.timezone].filter(Boolean).join(", ")}</div>
                    </div>
                    <Badge tone={u.role === "admin" ? "dark" : u.role === "va" ? "accent" : "neutral"}>{ROLE_LABEL[u.role]}</Badge>
                    <Button size="sm" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => setReset(u)}>
                      Reset password
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>

            <h2 data-tour="admin-matrix" className="mt-8 w-fit text-[15px] font-semibold">Who serves whom</h2>
            <p className="mt-0.5 text-[13px] text-ink-3">A VA only sees the users ticked here. Admins see every user.</p>
            {vas.length === 0 || agents.length === 0 ? (
              <Card className="mt-3">
                <Empty title="Add at least one VA and one user" body="Once both exist you can match them here." />
              </Card>
            ) : (
              <Card className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs text-ink-3">
                      <th className="px-4 py-2 font-medium">VA</th>
                      {agents.map((a) => (
                        <th key={a.id} className="px-3 py-2 font-medium">
                          {a.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {vas.map((va) => (
                      <tr key={va.id}>
                        <td className="px-4 py-2.5 font-medium">{va.name}</td>
                        {agents.map((a) => (
                          <td key={a.id} className="px-3 py-2.5">
                            <input type="checkbox" aria-label={`${va.name} serves ${a.name}`} className="h-4 w-4 accent-[#0d0d0d]" checked={va.assigned_agent_ids.includes(a.id)} onChange={(e) => toggle(va, a.id, e.target.checked)} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </>
        ) : null}
      </main>

      <Coach name="admin" steps={TOURS.admin} ready={!!data} />

      <Modal
        open={create}
        onClose={() => setCreate(false)}
        title="Add person"
        footer={
          <>
            <Button onClick={() => setCreate(false)}>Cancel</Button>
            <Button variant="primary" busy={busy} onClick={createUser}>
              Create account
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Role">
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="agent">User</option>
                <option value="va">VA</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
          </div>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="off" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Company" hint="Optional">
              <Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
            </Field>
            <Field label="Time zone" hint={form.role === "agent" ? "Deadlines follow this zone." : undefined}>
              <Select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                {ZONES.map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Temporary password" hint="At least 8 characters. Share it with them directly.">
            <Input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!reset}
        onClose={() => setReset(null)}
        title={`Reset password for ${reset?.name ?? ""}`}
        footer={
          <>
            <Button onClick={() => setReset(null)}>Cancel</Button>
            <Button variant="primary" busy={busy} onClick={resetPassword}>
              Change password
            </Button>
          </>
        }
      >
        <Field label="New password" hint="At least 8 characters.">
          <Input value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
      </Modal>
    </div>
  );
}

export default function Page() {
  return (
    <Authed roles={["admin"]}>
      <AdminPage />
    </Authed>
  );
}
