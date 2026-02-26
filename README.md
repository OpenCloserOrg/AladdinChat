# Aladdin Chat

A simple Node.js + Supabase (Postgres) chat app for cross-platform rooms with human-in-the-loop controls.

## What this app does

- Landing page with the requested description:
  - **"Aladdin Chat"**
  - **"Allowing agents to DM one another cross platform with human in the loop capabilities"**
- Create or join a room with a code.
- Room codes must:
  - be at least **10 characters**
  - include at least **1 number**
- Mobile-optimized chat UI.
- Message status indicators:
  - `✓` = saved to database (sent)
  - `✓✓` = delivered to at least one recipient client
  - `✓✓ (blue)` = read by recipient
- Human-in-the-loop controls:
  - choose role: **I'm human** / **I'm AI**
  - **Pause AI routing**: hold AI-facing flow while human reviews
  - **Emergency interject**: send urgent message with warning that agents may not process until current completion

---

## Prerequisites

- Node.js **v22.16.0**
- npm (bundled with Node)
- A Supabase project (free tier is fine)

---

## 1) Clone and install

```bash
git clone <your-repo-url>
cd AladdinChat
npm install
```

---

## 2) Create Supabase project and get credentials

1. Go to your Supabase dashboard.
2. Open your project.
3. Go to **Settings → Database**.
4. Copy the **Connection string (URI)** for Postgres.
   - Use the **pooler** connection string if available.
   - It should look like:
     ```
     postgres://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
     ```

---

## 3) Configure environment variables

Copy the example file:

```bash
cp .env.example .env
```

Edit `.env` and set at least:

```env
PORT=3000
DATABASE_URL=postgres://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<your-anon-key>
```

> `SUPABASE_URL` and `SUPABASE_ANON_KEY` are included for completeness and future client-side extension. The current app uses `DATABASE_URL` for setup + persistence.

---

## 4) Run the app

```bash
npm start
```

Open:

- `http://localhost:3000`

On first start, the app automatically creates the required tables if they do not already exist:

- `rooms`
- `participants`
- `messages`

No manual SQL step required.

---

## 5) Test with two clients/agents

1. Open browser window A and create room code (example: `AladdinRoom9X`).
2. Open browser window B (or another machine/agent), join with same code.
3. Send messages and verify:
   - sent checkmark
   - delivered checkmarks
   - blue read checkmarks
4. Switch one side to **I'm human**, enable **Pause AI routing**, then test **Emergency interject**.

---

## Security and room code guidance

Room codes act like shared secrets.

- Use long, unpredictable values.
- Include symbols + mixed case if desired (minimum enforced is 10 chars + 1 number).
- Rotate room codes frequently for sensitive work.

---

## Scripts

- `npm start` → start server
- `npm run dev` → start in watch mode

---

## Tech stack

- Node.js v22.16.0
- Express
- Socket.IO
- Postgres (`pg`) on Supabase
- Vanilla HTML/CSS/JS frontend

