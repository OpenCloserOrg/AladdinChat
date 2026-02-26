const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL is not set. Supabase database connection is required.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id BIGSERIAL PRIMARY KEY,
      room_code TEXT UNIQUE NOT NULL,
      pause_ai BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS participants (
      id BIGSERIAL PRIMARY KEY,
      room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      socket_id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('human', 'ai')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      sender_socket_id TEXT NOT NULL,
      sender_role TEXT NOT NULL CHECK (sender_role IN ('human', 'ai')),
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sent', 'delivered', 'read')) DEFAULT 'sent',
      emergency_interject BOOLEAN NOT NULL DEFAULT FALSE,
      held_for_ai BOOLEAN NOT NULL DEFAULT FALSE,
      task_state TEXT NOT NULL DEFAULT 'none' CHECK (task_state IN ('none', 'task_start', 'task_update', 'task_complete')),
      task_description TEXT,
      delayed_for_ai_until TIMESTAMPTZ,
      blocked_by_interject BOOLEAN NOT NULL DEFAULT FALSE,
      released_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE messages ADD COLUMN IF NOT EXISTS task_state TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS task_description TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS delayed_for_ai_until TIMESTAMPTZ;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS blocked_by_interject BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'messages_task_state_check'
      ) THEN
        ALTER TABLE messages
        ADD CONSTRAINT messages_task_state_check
        CHECK (task_state IN ('none', 'task_start', 'task_update', 'task_complete'));
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_rooms_code ON rooms (room_code);
    CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages (room_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_delay ON messages (room_id, delayed_for_ai_until);
  `);
}

async function getRoomByCode(code) {
  const { rows } = await pool.query('SELECT * FROM rooms WHERE room_code = $1 LIMIT 1', [code]);
  return rows[0] || null;
}

async function createRoom(code) {
  const { rows } = await pool.query('INSERT INTO rooms (room_code) VALUES ($1) RETURNING *', [code]);
  return rows[0];
}

async function getMessages(roomId, viewerRole = 'human', viewerSocketId = '') {
  const isAiViewer = viewerRole === 'ai';
  const { rows } = await pool.query(
    `SELECT id, sender_socket_id AS "senderSocketId", sender_role AS "senderRole", body,
            status, emergency_interject AS "emergencyInterject", held_for_ai AS "heldForAi",
            task_state AS "taskState", task_description AS "taskDescription",
            delayed_for_ai_until AS "delayedForAiUntil", blocked_by_interject AS "blockedByInterject",
            released_at AS "releasedAt", created_at AS "createdAt"
     FROM messages
     WHERE room_id = $1
       AND (
         $2::boolean = FALSE
         OR sender_socket_id = $3
         OR (
           blocked_by_interject = FALSE
           AND (delayed_for_ai_until IS NULL OR delayed_for_ai_until <= NOW())
         )
       )
     ORDER BY created_at ASC`,
    [roomId, isAiViewer, viewerSocketId],
  );
  return rows;
}

async function saveMessage({
  roomId,
  senderSocketId,
  senderRole,
  body,
  status,
  emergencyInterject,
  heldForAi,
  taskState = 'none',
  taskDescription = null,
  delayedForAiUntil = null,
}) {
  const { rows } = await pool.query(
    `INSERT INTO messages (
      room_id, sender_socket_id, sender_role, body, status, emergency_interject, held_for_ai,
      task_state, task_description, delayed_for_ai_until
    )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, sender_socket_id AS "senderSocketId", sender_role AS "senderRole", body,
               status, emergency_interject AS "emergencyInterject", held_for_ai AS "heldForAi",
               task_state AS "taskState", task_description AS "taskDescription",
               delayed_for_ai_until AS "delayedForAiUntil", blocked_by_interject AS "blockedByInterject",
               released_at AS "releasedAt", created_at AS "createdAt"`,
    [roomId, senderSocketId, senderRole, body, status, emergencyInterject, heldForAi, taskState, taskDescription, delayedForAiUntil],
  );
  return rows[0];
}

async function markDelivered(messageId) {
  await pool.query(`UPDATE messages SET status = 'delivered' WHERE id = $1 AND status = 'sent'`, [messageId]);
}

async function markRead(messageIds) {
  await pool.query(`UPDATE messages SET status = 'read' WHERE id = ANY($1::uuid[])`, [messageIds]);
}

async function setRoomPause(roomId, pauseAi) {
  await pool.query('UPDATE rooms SET pause_ai = $2 WHERE id = $1', [roomId, pauseAi]);
}

async function getParticipantRoles(roomId) {
  const { rows } = await pool.query('SELECT DISTINCT role FROM participants WHERE room_id = $1', [roomId]);
  return rows.map((row) => row.role);
}

async function markMessageReleased(messageId) {
  await pool.query('UPDATE messages SET released_at = NOW() WHERE id = $1', [messageId]);
}

async function blockMessageByInterject(messageId) {
  await pool.query('UPDATE messages SET blocked_by_interject = TRUE, released_at = NOW() WHERE id = $1', [messageId]);
}

module.exports = {
  pool,
  initializeDatabase,
  getRoomByCode,
  createRoom,
  getMessages,
  saveMessage,
  markDelivered,
  markRead,
  setRoomPause,
  getParticipantRoles,
  markMessageReleased,
  blockMessageByInterject,
};
