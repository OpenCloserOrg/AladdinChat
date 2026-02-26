const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');

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
  upsertParticipant,
  markMessageReleased,
  blockMessageByInterject,
} = require('./src/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const roomState = new Map();
const roomParticipants = new Map();
const AI_MESSAGE_DELAY_MS = 10_000;

const port = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/rooms', async (req, res) => {
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

io.on('connection', (socket) => {
  socket.on('join-room', async ({ roomCode, role }) => {
    try {
      const room = await getRoomByCode(roomCode);
      if (!room) {
        socket.emit('chat-error', 'Room not found.');
        return;
      }

      const safeRole = role === 'human' ? 'human' : 'ai';
      socket.data.roomCode = roomCode;
      socket.data.role = safeRole;
      socket.data.clientId = uuidv4();

      socket.join(roomCode);

      const displayName = assignDisplayName(roomCode, socket.id, safeRole);
      socket.data.displayName = displayName;

      await upsertParticipant({ roomId: room.id, socketId: socket.id, role: safeRole, displayName });

      const messages = await getMessages(room.id, safeRole, socket.id);
      const state = ensureRoomState(roomCode);
      socket.emit('chat-history', {
        messages,
        pauseAi: room.pause_ai,
        interjectActive: state.interjectActive,
        pendingDelay: state.pending.map((entry) => ({ messageId: entry.messageId, releaseAt: entry.releaseAt })),
      });

      io.to(roomCode).emit('participant-update', {
        count: io.sockets.adapter.rooms.get(roomCode)?.size || 0,
        participants: listParticipantDisplayNames(roomCode),
      });
    } catch (error) {
      console.error('join-room error', error);
      socket.emit('chat-error', 'Unable to join room.');
    }
  });

  socket.on('set-role', async ({ roomCode, role }) => {
    if (!roomCode || !['human', 'ai'].includes(role)) {
      return;
    }

    socket.data.role = role;

    try {
      const displayName = assignDisplayName(roomCode, socket.id, role);
      socket.data.displayName = displayName;
      const room = await getRoomByCode(roomCode);
      if (room) {
        await upsertParticipant({ roomId: room.id, socketId: socket.id, role, displayName });
      }
      io.to(roomCode).emit('role-updated', { socketId: socket.id, role, displayName });
      io.to(roomCode).emit('participant-update', {
        count: io.sockets.adapter.rooms.get(roomCode)?.size || 0,
        participants: listParticipantDisplayNames(roomCode),
      });
    } catch (error) {
      console.error('set-role error', error);
    }
  });

  socket.on('toggle-pause-ai', async ({ roomCode, pauseAi }) => {
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
    if (!roomCode || socket.data.role !== 'human') return;
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

      const roomSockets = io.sockets.adapter.rooms.get(roomCode) || new Set();
      const recipientSockets = [...roomSockets].filter((id) => id !== socket.id);
      const recipients = recipientSockets.map((id) => io.sockets.sockets.get(id)).filter(Boolean);
      const aiRecipients = recipients.filter((recipient) => recipient.data.role === 'ai');
      const nonAiRecipients = recipients.filter((recipient) => recipient.data.role !== 'ai');

      socket.emit('message-new', message);
      for (const recipient of nonAiRecipients) {
        recipient.emit('message-new', message);
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
          message,
          timer: setTimeout(async () => {
            const currentState = ensureRoomState(roomCode);
            currentState.pending = currentState.pending.filter((entry) => entry.messageId !== message.id);

            if (!currentState.interjectActive) {
              const roomMembers = io.sockets.adapter.rooms.get(roomCode) || new Set();
              for (const memberId of roomMembers) {
                if (memberId === socket.id) continue;
                const memberSocket = io.sockets.sockets.get(memberId);
                if (memberSocket?.data.role === 'ai') {
                  memberSocket.emit('message-new', message);
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
      await pool.query('DELETE FROM participants WHERE socket_id = $1', [socket.id]);
      if (roomCode) {
        removeParticipant(roomCode, socket.id);
        io.to(roomCode).emit('participant-update', {
          count: io.sockets.adapter.rooms.get(roomCode)?.size || 0,
          participants: listParticipantDisplayNames(roomCode),
        });
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

function ensureParticipantState(roomCode) {
  if (!roomParticipants.has(roomCode)) {
    roomParticipants.set(roomCode, { humanOrder: [], aiOrder: [], names: new Map() });
  }
  return roomParticipants.get(roomCode);
}

function assignDisplayName(roomCode, socketId, role) {
  const participantState = ensureParticipantState(roomCode);
  const existing = participantState.names.get(socketId);
  if (existing && existing.role === role) {
    return existing.displayName;
  }

  if (existing) {
    if (existing.role === 'human') {
      participantState.humanOrder = participantState.humanOrder.filter((id) => id !== socketId);
    } else {
      participantState.aiOrder = participantState.aiOrder.filter((id) => id !== socketId);
    }
  }

  const order = role === 'human' ? participantState.humanOrder : participantState.aiOrder;
  order.push(socketId);
  const displayName = `${role === 'human' ? 'Human' : 'AI'}${order.length}`;
  participantState.names.set(socketId, { role, displayName });
  return displayName;
}

function listParticipantDisplayNames(roomCode) {
  const participantState = ensureParticipantState(roomCode);
  return [...participantState.names.values()].map((entry) => entry.displayName);
}

function removeParticipant(roomCode, socketId) {
  const participantState = ensureParticipantState(roomCode);
  const existing = participantState.names.get(socketId);
  if (!existing) return;

  participantState.names.delete(socketId);
  if (existing.role === 'human') {
    participantState.humanOrder = participantState.humanOrder.filter((id) => id !== socketId);
  } else {
    participantState.aiOrder = participantState.aiOrder.filter((id) => id !== socketId);
  }
}

function isValidCode(code) {
  return typeof code === 'string' && code.length >= 10 && /\d/.test(code);
}

(async () => {
  try {
    await initializeDatabase();
    server.listen(port, () => {
      console.log(`Aladdin Chat listening on http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Unable to start server', error);
    process.exit(1);
  }
})();
