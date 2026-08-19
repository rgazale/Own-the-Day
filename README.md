# MDC Daily

One always-current window listing **every open task assigned to you** — pulled
from monday.com and your Outlook inbox, merged with tasks you type in yourself,
and sorted by urgency. Runs in the Windows system tray, syncs in the background,
and works offline against the last sync.

Built for Ryan Gazale, RCDD — MDC Low Voltage Systems.

---

## What it does

- **monday.com** — every parent item and subitem on board *1. Design Tasks Board*
  where the Owner column includes you, with the real due dates.
- **Outlook** — action items aimed at you (direct asks, @-mentions, deadlines,
  RFI/PCO clocks), scored by an editable rule file.
- **Manual tasks** — anything you type in; lives only in the app.

Everything is grouped **Overdue → Due today → This week → Scheduled → No due
date**, with a per-bucket count and a day-countdown on each row. Check things
off, snooze them, dismiss email threads, and add your own — all saved locally and
**never lost on sync**.

### Your chosen settings (baked into `.env.example`)
| Setting | Value |
|---|---|
| Write-back to monday / Outlook | **Off** (read-only; check-offs are local) |
| Background sync interval | **60 min** (plus on-launch + a manual button) |
| Overdue notification | **On**, at most one digest per day |
| Stack | **Electron + SQLite**, single Windows installer |

You can change any of these later by editing `.env` — no code changes needed.

---

## 1. Get your two sets of credentials

### A. monday.com personal API token
1. Sign in to `mdc-lvs.monday.com`.
2. Click your **avatar** (bottom-left) → **Developers**.
3. **My access tokens** → **Show** (or **Generate**). Copy the token.
4. Paste it into `.env` as `MONDAY_API_TOKEN=...`

That's all monday needs. The board ID (`18417698484`) and your user ID
(`100030091`) are already filled in.

### B. Microsoft 365 / Outlook — Azure app registration
MDC Daily reads your mail with **Microsoft Graph** using *delegated* permissions
and a **public client** (no client secret is ever stored). You sign in once; the
refresh token is kept in the **Windows Credential Manager**, never in a file.

**What you need to do in Azure (one time):**

1. Go to **https://portal.azure.com** → search **App registrations** → **New
   registration**.
2. **Name:** `MDC Daily`.
3. **Supported account types:** *Accounts in this organizational directory only
   (mcmillanlv.com only — Single tenant)*.
4. **Redirect URI:** choose **Public client/native (mobile & desktop)** and enter
   `http://localhost` (only used if you switch to the interactive flow; the
   default device-code flow doesn't need it).
5. Click **Register**. On the overview page copy:
   - **Application (client) ID** → `.env` `MS_CLIENT_ID=...`
   - **Directory (tenant) ID** → `.env` `MS_TENANT_ID=...` (or leave it as
     `mcmillanlv.com`).
6. Left menu → **Authentication** → scroll to **Advanced settings** → set
   **Allow public client flows** = **Yes** → **Save**. (This enables the
   device-code sign-in.)
7. Left menu → **API permissions** → **Add a permission** → **Microsoft Graph**
   → **Delegated permissions** → add **`Mail.Read`** and **`offline_access`**.
   (`User.Read` is usually there already. Add **`Mail.ReadWrite`** *only* if you
   ever turn write-back on.)

**Will you need an admin?** `Mail.Read` and `offline_access` are normally
consentable by you as the signed-in user, so you likely **won't** need admin
approval. If your tenant is locked down you'll see a *"Need admin approval"*
screen the first time you sign in — click **Request approval** and your M365
admin approves it once. `Mail.ReadWrite` is more likely to require admin consent,
which is another reason write-back ships off.

**If your org blocks app registration entirely:** you have a fallback. On your
Windows PC, Outlook exposes a local **COM/MAPI** interface that reads the same
mailbox without any Azure app. It's Windows-only and needs the Outlook desktop
client running. Tell me and I'll wire `src/sync/outlook.js` to a MAPI reader
instead of Graph — the rest of the app is unchanged. (You choose; Graph is the
default because it's cleaner and works even when Outlook desktop is closed.)

> **Until `MS_CLIENT_ID` is set, MDC Daily simply skips Outlook** and shows your
> monday + manual tasks. It never blocks on email.

---

## 2. Install & run

### Prerequisites
- **Node.js 18+** (only needed to build; the installed app is self-contained).
- Windows 11 (x64).

### First run (development)
```bat
copy .env.example .env      :: then paste your token + client ID into .env
npm install
npm start
```

> No compiler needed. MDC Daily uses pure-JavaScript dependencies (SQLite via
> `sql.js`/WebAssembly, and Windows DPAPI encryption via Electron's built-in
> `safeStorage`), so `npm install` just downloads files — it does **not** need
> Python or Visual Studio build tools.

### Prove the monday sync from the console (before any UI)
```bat
npm run prove:monday
```
This prints every task assigned to you, grouped by bucket with due dates
reconstructed from monday's activity log, then spot-checks the known-good values
(e.g. *Anthropic 300 Howard → Phase 1 100% CD = 2026-08-07*, *Wu Yee = no due
date*).

### Build the double-click Windows installer
```bat
npm run dist
```
The signed-ready NSIS installer lands in `release\MDC Daily Setup <version>.exe`.
Double-click to install; it creates Start-menu and desktop shortcuts and (per
your setting) **starts with Windows** via a proper registry entry. The app lives
in the tray — its icon badges with your overdue + due-today count.

---

## 3. Tune the email classifier — `config/email-rules.json`

The classifier scores each email; a thread becomes a task when its score meets
`threshold`. Everything is editable — save the file and click **Sync now**.

- `threshold` — raise it if too much email shows up, lower it if real asks are
  missed.
- `recipientWeights` — how much To-only / To-first / To / Cc placement counts.
- `requestVerbs`, `deadlineTerms` — phrase lists that signal a real ask.
- `denySenders` — automated senders that are dropped outright
  (`noreply@`, Procore/Autodesk/BIM360 bots, etc.). Add offenders here.
- `allowSenders.domains` — real program domains (jll.com, arup.com, snap.com,
  fhda.edu, altenconstruction.com, mcmillanlv.com, …) that get a small bonus.
- `largeDistributionList` — penalizes big Cc blasts **unless** your name appears
  next to a request in the body.
- `fyiPhrases` — "for your records", "please see attached", etc.

Tips: to force-drop a chronic notifier, add its address to
`denySenders.contains`. To make sure a client's mail always clears the bar, add
their domain to `allowSenders.domains`.

---

## 4. Reset local state if it gets weird

All local state (check-offs, snoozes, dismissals, manual tasks) lives in one
SQLite file:

```
%APPDATA%\MDC Daily\data\mdc-daily.sqlite
```

- **Full reset:** quit MDC Daily (tray → Quit), delete that `data` folder, relaunch.
  Your monday/Outlook tasks re-sync fresh; only local check-offs/snoozes/manual
  tasks are lost.
- **Re-run Outlook sign-in:** delete `msal-token-cache.bin` from the same `data`
  folder above (it's your encrypted token), then Sync now to sign in again.
- **Audit any write-back:** if you ever enable write-back, every mutation is
  appended to `mutation-audit.log` in the same `data` folder.

---

## How the pieces fit

```
src/
  parsers/
    mondayDates.js      reconstruct rollup date columns from the activity log
    emailClassifier.js  score an email -> is it a task for me?
    buckets.js          grouping + urgency sort + tray count
  sync/
    mondayApi.js        GraphQL client (429 backoff)
    monday.js           items + subitems (person filter) + date join
    outlook.js          MSAL public client + Graph inbox/sent + classify
    engine.js           run both sources, merge into the DB, fail gracefully
    writeback.js        OPTIONAL guarded mutations + audit log (off by default)
  main/
    db.js               SQLite schema + merge-by-stable-id (never wipes state)
    config.js           .env + email-rules loader
    keychain.js         encrypted token storage (Electron safeStorage / DPAPI)
    main.js             tray, window, scheduler, autostart, notifications, IPC
  renderer/             the titleblock UI (index.html / styles.css / renderer.js)
test/                   parser tests + fixtures  (npm test)
scripts/prove-monday.js console proof of the monday sync
```

### Why the monday date handling looks unusual
The four date columns on that board are **rollup** columns, and the monday API
silently omits them from `items { column_values }`. MDC Daily reconstructs the
current value by reading the board **activity log** newest-first and keeping the
first value it sees per item (a `null` value means the date was cleared). This is
covered by unit tests in `test/mondayDates.test.js` and validated against
known-good values from the board.

---

## Running the tests
```bat
npm test
```
Covers the two parsers (activity-log date reconstruction, email classifier) and
the bucketing logic, with fixtures under `test/fixtures/`.
