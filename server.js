const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const dotenv = require('dotenv');

dotenv.config();

const {
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
  getParticipantByClient,
  upsertParticipant,
  setParticipantOffline,
  listParticipants,
  hasPrimaryHuman,
  markMessageReleased,
  blockMessageByInterject,
} = require('./src/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const roomState = new Map();
const AI_MESSAGE_DELAY_MS = 10_000;
const dbState = {
  ready: false,
  checkedAt: null,
  error: null,
};

const port = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/setup-status', (req, res) => {
  res.json({
    ok: dbState.ready,
    ready: dbState.ready,
    checkedAt: dbState.checkedAt,
    error: dbState.error,
    requiredEnv: ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'],
  });
});

function ensureDatabaseReady(res) {
  if (dbState.ready) return true;

  res.status(503).json({
    error: 'Database is not connected yet. Please finish Supabase setup and refresh.',
    setupPath: '/api/setup-status',
  });
  return false;
}

app.post('/api/rooms', async (req, res) => {
  if (!ensureDatabaseReady(res)) return;
  const { code } = req.body;
  if (!isValidCode(code)) {
    return res.status(400).json({ error: 'Code must be at least 10 chars and include one number.' });
  }

  try {
    const room = await getRoomByCode(code);
    if (room) {
      return res.status(409).json({ error: 'Room code already exists.' });
    }

    const created = await createRoom(code);
    return res.status(201).json({ roomId: created.id, roomCode: created.room_code });
  } catch (error) {
    console.error('Failed to create room', error);
    return res.status(500).json({ error: 'Unable to create room.' });
  }
});

app.post('/api/rooms/join', async (req, res) => {
  if (!ensureDatabaseReady(res)) return;
  const { code } = req.body;

  if (!isValidCode(code)) {
    return res.status(400).json({ error: 'Code must be at least 10 chars and include one number.' });
  }

  try {
    const room = await getRoomByCode(code);
    if (!room) {
      return res.status(404).json({ error: 'Room not found.' });
    }

    return res.json({ roomId: room.id, roomCode: room.room_code, pauseAi: room.pause_ai });
  } catch (error) {
    console.error('Failed to join room', error);
    return res.status(500).json({ error: 'Unable to join room.' });
  }
});

io.use((socket, next) => {
  if (!dbState.ready) {
    next(new Error('Database is not connected yet. Please configure Supabase env vars first.'));
    return;
  }

  next();
});

io.on('connection', (socket) => {
  socket.on('join-room', async ({ roomCode, role, clientId }) => {
    try {
      const room = await getRoomByCode(roomCode);
      if (!room) {
        socket.emit('chat-error', 'Room not found.');
        return;
      }

      if (clientId && !isValidClientId(clientId)) {
        socket.emit('chat-error', 'Invalid participant ID. Please refresh and join again.');
        return;
      }

      const existingParticipant = clientId ? await getParticipantByClient(room.id, clientId) : null;
      const safeRole = existingParticipant?.role || (role === 'human' ? 'human' : 'ai');
      const isPrimaryHuman = safeRole === 'human' && (!existingParticipant
        ? !(await hasPrimaryHuman(room.id))
        : Boolean(existingParticipant.is_primary_human));

      socket.data.roomCode = roomCode;
      socket.data.role = safeRole;
      socket.data.clientId = existingParticipant?.client_id || (isValidClientId(clientId) ? clientId : null);

      socket.join(roomCode);

      const displayName = existingParticipant?.display_name || '';
      socket.data.displayName = displayName;
      socket.data.isPrimaryHuman = isPrimaryHuman;

      if (existingParticipant) {
        await upsertParticipant({
          roomId: room.id,
          socketId: socket.id,
          clientId: existingParticipant.client_id,
          role: safeRole,
          displayName: existingParticipant.display_name,
          isPrimaryHuman: Boolean(existingParticipant.is_primary_human),
        });
      }

      const messages = await getMessages(room.id, safeRole, socket.id);
      const state = ensureRoomState(roomCode);
      socket.emit('chat-history', {
        messages,
        pauseAi: room.pause_ai,
        interjectActive: state.interjectActive,
        pendingDelay: state.pending.map((entry) => ({ messageId: entry.messageId, releaseAt: entry.releaseAt })),
      });

      if (existingParticipant) {
        socket.emit('role-locked', {
          role: safeRole,
          displayName: existingParticipant.display_name,
          isPrimaryHuman: Boolean(existingParticipant.is_primary_human),
        });
      }

      await emitParticipantUpdate(roomCode, room.id);
    } catch (error) {
      console.error('join-room error', error);
      socket.emit('chat-error', 'Unable to join room.');
    }
  });

  socket.on('set-role', async ({ roomCode, role }) => {
    if (!roomCode || socket.data.roomCode !== roomCode) return;

    if (socket.data.clientId) {
      socket.emit('chat-error', 'Role is locked to your participant ID for this room.');
      return;
    }

    const safeRole = role === 'human' ? 'human' : 'ai';
    socket.data.role = safeRole;
    socket.emit('role-selected', { role: safeRole });
  });

  socket.on('toggle-pause-ai', async ({ roomCode, pauseAi }) => {
    if (!socket.data.isPrimaryHuman) {
      socket.emit('chat-error', 'Only the first human in this room can control pause/interjection.');
      return;
    }
    try {
      const room = await getRoomByCode(roomCode);
      if (!room) return;

      await setRoomPause(room.id, Boolean(pauseAi));
      io.to(roomCode).emit('pause-updated', { pauseAi: Boolean(pauseAi) });

      if (!pauseAi) {
        const pending = await pool.query(
          `SELECT m.* FROM messages m
           WHERE m.room_id = $1 AND m.held_for_ai = TRUE
           ORDER BY m.created_at ASC`,
          [room.id],
        );

        if (pending.rows.length > 0) {
          await pool.query('UPDATE messages SET held_for_ai = FALSE WHERE room_id = $1 AND held_for_ai = TRUE', [room.id]);
          io.to(roomCode).emit('release-held-messages', { messageIds: pending.rows.map((m) => m.id) });
        }
      }
    } catch (error) {
      console.error('toggle-pause-ai error', error);
    }
  });

  socket.on('start-interject', async ({ roomCode }) => {
    if (!roomCode || socket.data.role !== 'human' || !socket.data.isPrimaryHuman) return;
    const state = ensureRoomState(roomCode);
    state.interjectActive = true;

    const pendingToQueue = [...state.pending].sort((a, b) => a.createdAt - b.createdAt);

    for (const pending of pendingToQueue) {
      clearTimeout(pending.timer);
      pending.blocked = true;
      await blockMessageByInterject(pending.messageId);
      const roomMembers = io.sockets.adapter.rooms.get(roomCode) || new Set();
      for (const memberId of roomMembers) {
        if (memberId === pending.senderSocketId) continue;
        const memberSocket = io.sockets.sockets.get(memberId);
        if (memberSocket?.data.role === 'ai') {
          memberSocket.emit('message-new', pending.message);
        }
      }
      await markMessageReleased(pending.messageId);
    }

    state.pending = [];
    io.to(roomCode).emit('interject-updated', { active: true });
    io.to(roomCode).emit('pending-delay-update', { pending: [] });
    io.to(roomCode).emit('toast-update', {
      level: 'warning',
      message: 'Awaiting human interjection... queued AI messages were released to AI participants.',
    });
  });

  socket.on('send-message', async ({ roomCode, text, emergencyInterject = false, taskState = 'none', taskDescription = '' }) => {
    if (!roomCode || !text || !text.trim()) return;

    try {
      const room = await getRoomByCode(roomCode);
      if (!room) return;

      if (!socket.data.clientId) {
        let assignedClientId = createClientId();
        while (await getParticipantByClient(room.id, assignedClientId)) {
          assignedClientId = createClientId();
        }

        const assignedRole = socket.data.role === 'human' ? 'human' : 'ai';
        const assignedPrimaryHuman = assignedRole === 'human' ? !(await hasPrimaryHuman(room.id)) : false;
        const assignedDisplayName = assignedRole === 'human'
          ? `${assignedPrimaryHuman ? 'MainHuman' : 'Human'}-${assignedClientId}`
          : `AI-${assignedClientId}`;

        await upsertParticipant({
          roomId: room.id,
          socketId: socket.id,
          clientId: assignedClientId,
          role: assignedRole,
          displayName: assignedDisplayName,
          isPrimaryHuman: assignedPrimaryHuman,
        });

        socket.data.clientId = assignedClientId;
        socket.data.displayName = assignedDisplayName;
        socket.data.isPrimaryHuman = assignedPrimaryHuman;

        socket.emit('role-locked', {
          role: assignedRole,
          displayName: assignedDisplayName,
          isPrimaryHuman: assignedPrimaryHuman,
        });
        await emitParticipantUpdate(roomCode, room.id);
      }

      const cleanText = text.trim().slice(0, 5000);
      const senderRole = socket.data.role === 'human' ? 'human' : 'ai';
      const roles = await getParticipantRoles(room.id);
      const hasHuman = roles.includes('human');
      const heldForAi = room.pause_ai && hasHuman && senderRole === 'human' && !emergencyInterject;
      const safeTaskState = ['none', 'task_start', 'task_update', 'task_complete'].includes(taskState) ? taskState : 'none';
      const safeTaskDescription = String(taskDescription || '').trim().slice(0, 500);
      const delayedForAiUntil = senderRole === 'ai' ? new Date(Date.now() + AI_MESSAGE_DELAY_MS).toISOString() : null;

      const senderDisplayName = socket.data.displayName || (senderRole === 'human' ? 'Human' : 'AI');
      const message = await saveMessage({
        roomId: room.id,
        senderSocketId: socket.id,
        senderRole,
        senderDisplayName,
        body: cleanText,
        status: 'sent',
        emergencyInterject,
        heldForAi,
        taskState: safeTaskState,
        taskDescription: safeTaskDescription || null,
        delayedForAiUntil,
      });

      const isHumanInterjection = senderRole === 'human' && Boolean(emergencyInterject);
      const outboundMessage = isHumanInterjection
        ? { ...message, humanInterjection: true, interjectionFlag: 'HUMAN' }
        : message;

      const roomSockets = io.sockets.adapter.rooms.get(roomCode) || new Set();
      const recipientSockets = [...roomSockets].filter((id) => id !== socket.id);
      const recipients = recipientSockets.map((id) => io.sockets.sockets.get(id)).filter(Boolean);
      const aiRecipients = recipients.filter((recipient) => recipient.data.role === 'ai');
      const nonAiRecipients = recipients.filter((recipient) => recipient.data.role !== 'ai');

      socket.emit('message-new', outboundMessage);
      for (const recipient of nonAiRecipients) {
        recipient.emit('message-new', outboundMessage);
      }

      const shouldSendToAiImmediately = senderRole === 'human' && (!heldForAi || isHumanInterjection);
      if (shouldSendToAiImmediately) {
        for (const recipient of aiRecipients) {
          recipient.emit('message-new', outboundMessage);
        }
      }

      if (senderRole === 'ai' && aiRecipients.length > 0) {
        const state = ensureRoomState(roomCode);
        const releaseAt = Date.now() + AI_MESSAGE_DELAY_MS;
        const pendingEntry = {
          messageId: message.id,
          senderSocketId: socket.id,
          releaseAt,
          createdAt: Date.now(),
          blocked: false,
          message: outboundMessage,
          timer: setTimeout(async () => {
            const currentState = ensureRoomState(roomCode);
            currentState.pending = currentState.pending.filter((entry) => entry.messageId !== message.id);

            if (!currentState.interjectActive) {
              const roomMembers = io.sockets.adapter.rooms.get(roomCode) || new Set();
              for (const memberId of roomMembers) {
                if (memberId === socket.id) continue;
                const memberSocket = io.sockets.sockets.get(memberId);
                if (memberSocket?.data.role === 'ai') {
                  memberSocket.emit('message-new', outboundMessage);
                }
              }
              await markMessageReleased(message.id);
              io.to(roomCode).emit('toast-update', {
                level: 'info',
                message: 'AI delay window ended. Message is now delivered to AI participants.',
              });
            }

            io.to(roomCode).emit('pending-delay-update', {
              pending: currentState.pending.map((entry) => ({ messageId: entry.messageId, releaseAt: entry.releaseAt })),
            });
          }, AI_MESSAGE_DELAY_MS),
        };

        state.pending.push(pendingEntry);
        io.to(roomCode).emit('pending-delay-update', {
          pending: state.pending.map((entry) => ({ messageId: entry.messageId, releaseAt: entry.releaseAt })),
        });
        io.to(roomCode).emit('toast-update', {
          level: 'info',
          message: 'Incoming AI message: sent to humans now, AI delivery in 10s unless a human interjects.',
        });
      }

      if (senderRole === 'human' && emergencyInterject) {
        const state = ensureRoomState(roomCode);
        state.interjectActive = false;
        io.to(roomCode).emit('interject-updated', { active: false });
        io.to(roomCode).emit('toast-update', {
          level: 'success',
          message: 'Human interjection sent after queued AI message delivery.',
        });
      }

      if (recipientSockets.length > 0) {
        await markDelivered(message.id);
        io.to(roomCode).emit('message-status', { messageId: message.id, status: 'delivered' });
      }
    } catch (error) {
      console.error('send-message error', error);
    }
  });

  socket.on('mark-read', async ({ messageIds = [] }) => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;

    try {
      await markRead(messageIds);
      if (socket.data.roomCode) {
        io.to(socket.data.roomCode).emit('messages-read', { messageIds });
      }
    } catch (error) {
      console.error('mark-read error', error);
    }
  });

  socket.on('disconnect', async () => {
    try {
      const roomCode = socket.data.roomCode;
      await setParticipantOffline(socket.id);
      if (roomCode) {
        const room = await getRoomByCode(roomCode);
        if (room) {
          await emitParticipantUpdate(roomCode, room.id);
        }
      }
    } catch (error) {
      console.error('disconnect cleanup error', error);
    }
  });
});


function ensureRoomState(roomCode) {
  if (!roomState.has(roomCode)) {
    roomState.set(roomCode, { interjectActive: false, pending: [] });
  }
  return roomState.get(roomCode);
}

function isValidCode(code) {
  return typeof code === 'string' && code.length >= 10 && /\d/.test(code);
}

function isValidClientId(clientId) {
  return typeof clientId === 'string' && /^[A-Z0-9]{5}$/.test(clientId);
}

function createClientId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 5; i += 1) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return id;
}

async function emitParticipantUpdate(roomCode, roomId) {
  const participants = await listParticipants(roomId);
  const onlineCount = participants.filter((participant) => participant.isOnline).length;
  io.to(roomCode).emit('participant-update', {
    count: onlineCount,
    participants,
  });
}

(async () => {
  try {
    await initializeDatabase();
    dbState.ready = true;
    dbState.checkedAt = new Date().toISOString();
    dbState.error = null;
  } catch (error) {
    dbState.ready = false;
    dbState.checkedAt = new Date().toISOString();
    dbState.error = error.message;
    console.error('Unable to connect to database on startup.', error);
    console.log('Server will still start so setup instructions can be shown in the browser.');
  }

  server.listen(port, () => {
    console.log(`Aladdin Chat listening on http://localhost:${port}`);
  });
})();
