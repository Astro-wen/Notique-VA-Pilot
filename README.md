# Notique VA Pilot

The working pilot for Notique 2.0: agents send in conversations, a VA verifies the AI-drafted facts against the transcript, and the agent hands follow-up work back to the VA.

Two apps share one deployment:

| Path | Who | What |
| --- | --- | --- |
| `/va` | VA, Admin | Queue, event verification, projects, tickets, data sources, QC review |
| `/agent` | Agent | Projects with Deal status, Timeline, Tasks, Files |
| `/admin` | Admin | Accounts and VA to agent assignments |
| `/p?t=...` | Anyone with the link | Read-only deal profile, expires after 14 days |

## First-time setup

1. **Database.** Open the Supabase SQL editor and run `supabase/migrations/20261111000000_init.sql` once. Skip this if the Supabase GitHub integration already applied it.
2. **Environment variables.** In Vercel, add the three required values from `.env.example`, then redeploy.
   - `SUPABASE_SECRET_KEY`: Supabase > Project Settings > API keys > Secret key (starts with `sb_secret_`)
   - `ASSEMBLYAI_API_KEY`: speech to text for recordings
   - `OPENROUTER_API_KEY`: fact extraction and screenshot reading
3. **First admin.** Visit `/setup` on the deployed site and create the admin account. The page locks itself once one account exists.
4. **People.** In `/admin`, add each VA and agent with a temporary password, then tick which agents each VA serves.

The Supabase URL and publishable key are public values and live in `lib/config.ts`.

## How it is built

- Next.js 16 App Router, React 19, Tailwind 4. Every page is client-rendered.
- One endpoint, `POST /api/rpc`, takes `{ fn, args }`. The handlers in `lib/server/rpc.ts` check the caller's role and agent assignment on every call.
- The browser never talks to the database. Row Level Security is on for every table with no policies, and the server uses the secret key.
- Files go straight from the browser to a private Supabase Storage bucket through signed upload URLs.
- Recordings: AssemblyAI with speaker labels. Text, transcripts, and screenshots: parsed on the server.
- Fact extraction: OpenRouter, JSON output, each fact must cite transcript line numbers that exist or it is dropped.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in the three keys
npm run dev
```

## Limits to know about

- Supabase Free caps uploads at 50 MB per file. Longer recordings need the Pro plan or a compressed file.
- Chat and status updates refresh by polling every 15 to 30 seconds.
- Follow Up Boss is not connected. Use Written note to bring CRM notes in and Copy profile note to take results out.
