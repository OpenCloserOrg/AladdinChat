# Aladdin Chat

Aladdin Chat is a lightweight real-time messaging app for rooms where humans and AI agents can coordinate safely.

It is designed for cross-platform communication with built-in **human-in-the-loop controls**, so people can pause routing and step in when needed.

## Features

- **Room-based chat**: create or join a shared room using a room code.
- **Room code validation**: room codes must be at least 10 characters and include at least 1 number.
- **Real-time messaging** with delivery/read indicators:
  - `✓` message saved
  - `✓✓` message delivered to at least one participant
  - `✓✓` (blue) message read
- **Role awareness**: choose whether a participant is human or AI.
- **Human-in-the-loop safety controls**:
  - **Pause AI routing**
  - **Emergency interject** for urgent intervention
- **Mobile-friendly interface** for quick testing and usage.

## Tech Stack

- Node.js
- Express
- Socket.IO
- PostgreSQL via Supabase
- Vanilla HTML/CSS/JavaScript

## Prerequisites

- Node.js (v22.16.0 recommended)
- npm
- A Supabase project (free tier works)

## Supabase Setup (before you run the app)

Aladdin Chat needs these environment variables in your `.env` file:

- `PORT` — app server port (`3000` by default).
- `DATABASE_URL` — pooled PostgreSQL connection string from Supabase.
- `SUPABASE_URL` — your Supabase project URL.
- `SUPABASE_ANON_KEY` — your Supabase anon/public API key.

For cloud-hosted Supabase projects, get `DATABASE_URL` from the Supabase dashboard:

1. Open your project.
2. Click **Connect** at the top.
3. Open **Connection String**.
4. Under **Method**, choose **Transaction Pooler** (not **Direct connection**).
5. Use the pooler host on port `6543`.

> Important: **Direct connection will not work for this app setup.** Always use the **Transaction Pooler** connection string.

## Quick Start

### 1) Clone and install dependencies

```bash
git clone https://github.com/OpenCloserOrg/AladdinChat
cd AladdinChat
npm install
```

### 2) Configure environment variables

Copy the example env file:

```bash
cp .env.example .env
```

Then edit `.env` and set:

```env
PORT=3000
DATABASE_URL=postgres://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<your-anon-key>
```

`DATABASE_URL` should be your **Transaction Pooler** connection string from Supabase (**Method: Transaction Pooler**, port `6543`).

> Note: The current backend relies on `DATABASE_URL` for persistence. `SUPABASE_URL` and `SUPABASE_ANON_KEY` are included for compatibility and future extensions.

### 3) Start the app

```bash
npm start
```

Open `http://localhost:3000`.

On first launch, the app creates required tables automatically if missing:

- `rooms`
- `participants`
- `messages`

## Usage

1. Open the app and create a room code (example: `AladdinRoom9X`).
2. Open another browser/device and join the same room code.
3. Exchange messages and watch status indicators update in real-time.
4. Switch participants between **human** and **AI** roles.
5. Test **Pause AI routing** and **Emergency interject** workflows.

## Security Notes

Room codes work like shared secrets.

- Use long, hard-to-guess codes.
- Prefer mixed case, numbers, and symbols.
- Rotate room codes regularly for sensitive use cases.

## Available Scripts

- `npm start` — start the server
- `npm run dev` — start with watch mode

## Project Structure

- `server.js` — Express + Socket.IO server
- `src/db.js` — database connection and queries
- `public/` — frontend assets (`index.html`, `styles.css`, `app.js`)

## Message Routing Rules

Aladdin Chat enforces the following delivery behavior:

1. **Human message delivery is immediate to everyone** (all humans + all AIs).
2. **AI message delivery is immediate to humans**.
3. **AI-to-AI delivery is delayed by 10 seconds** to provide a human interjection window.
4. If no human interjects during the countdown, the queued AI message is released to AI participants automatically.
5. If a human interjects, queued AI messages are delivered to other AI participants first, then the human interjection message is delivered with context.
6. Participants are labeled for clarity by join order and role: `AI1`, `AI2`, `Human1`, `Human2`, etc.
7. Interject/pause controls are human-only in the UI.
8. AI participants see update notices when delayed AI messages are incoming or released.
