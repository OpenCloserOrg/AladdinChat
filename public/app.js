const socket = io();

const landingScreen = document.getElementById('landing-screen');
const chatScreen = document.getElementById('chat-screen');
const landingError = document.getElementById('landing-error');
const joinForm = document.getElementById('join-form');
const createForm = document.getElementById('create-form');
const joinCodeInput = document.getElementById('join-code');
const createCodeInput = document.getElementById('create-code');
const roomLabel = document.getElementById('room-label');
const messagesEl = document.getElementById('messages');
const composer = document.getElementById('composer');
const messageInput = document.getElementById('message-input');
const presence = document.getElementById('presence');
const roleSelect = document.getElementById('role-select');
const pauseBtn = document.getElementById('pause-btn');
const emergencyBtn = document.getElementById('emergency-btn');
const pauseWarning = document.getElementById('pause-warning');
const interjectWarning = document.getElementById('interject-warning');

let roomCode = null;
let pauseAi = false;
let messageState = new Map();
let emergencyMode = false;

const statusIcon = {
  sent: '✓',
  delivered: '✓✓',
  read: '✓✓',
};

function setViewportHeight() {
  const vh = (window.visualViewport?.height || window.innerHeight) * 0.01;
  document.documentElement.style.setProperty('--vh', `${vh}px`);
}

setViewportHeight();
window.visualViewport?.addEventListener('resize', setViewportHeight);
window.addEventListener('orientationchange', setViewportHeight);

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  handleJoin(joinCodeInput.value.trim());
});

createForm.addEventListener('submit', (event) => {
  event.preventDefault();
  handleCreate(createCodeInput.value.trim());
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !roomCode) return;

  socket.emit('send-message', { roomCode, text, emergencyInterject: emergencyMode });
  messageInput.value = '';
  messageInput.focus();

  if (emergencyMode) {
    emergencyMode = false;
    interjectWarning.classList.add('hidden');
    emergencyBtn.textContent = 'Emergency interject';
  }
});

roleSelect.addEventListener('change', () => {
  if (!roomCode) return;
  socket.emit('set-role', { roomCode, role: roleSelect.value });
});

pauseBtn.addEventListener('click', () => {
  if (!roomCode) return;
  pauseAi = !pauseAi;
  socket.emit('toggle-pause-ai', { roomCode, pauseAi });
  updatePauseUi();
});

emergencyBtn.addEventListener('click', () => {
  emergencyMode = !emergencyMode;
  interjectWarning.classList.toggle('hidden', !emergencyMode);
  emergencyBtn.textContent = emergencyMode ? 'Emergency ON (next message)' : 'Emergency interject';
});

socket.on('chat-history', ({ messages, pauseAi: initialPauseAi }) => {
  pauseAi = Boolean(initialPauseAi);
  updatePauseUi();
  messagesEl.innerHTML = '';
  messageState.clear();

  for (const message of messages) {
    messageState.set(message.id, message);
    renderMessage(message);
  }

  markVisibleAsRead();
});

socket.on('message-new', (message) => {
  messageState.set(message.id, message);
  renderMessage(message);
  markVisibleAsRead();
});

socket.on('message-status', ({ messageId, status }) => {
  const existing = messageState.get(messageId);
  if (!existing) return;
  existing.status = status;
  messageState.set(messageId, existing);
  updateStatus(messageId, status);
});

socket.on('messages-read', ({ messageIds }) => {
  for (const id of messageIds) {
    const existing = messageState.get(id);
    if (!existing) continue;
    existing.status = 'read';
    messageState.set(id, existing);
    updateStatus(id, 'read');
  }
});

socket.on('pause-updated', ({ pauseAi: serverPause }) => {
  pauseAi = serverPause;
  updatePauseUi();
});

socket.on('release-held-messages', ({ messageIds }) => {
  for (const id of messageIds) {
    const bubble = document.querySelector(`[data-message-id="${id}"]`);
    if (bubble) bubble.classList.remove('hidden');
  }
});

socket.on('participant-update', ({ count }) => {
  presence.textContent = `${count} participant${count === 1 ? '' : 's'} online`;
});

socket.on('chat-error', (error) => {
  landingError.textContent = error;
});

function renderMessage(message) {
  const mine = message.senderSocketId === socket.id;
  const canSee = !message.heldForAi || roleSelect.value === 'human' || mine;
  const color = message.status === 'read' ? 'var(--ok)' : '#bfdbfe';

  const wrapper = document.createElement('article');
  wrapper.className = `message ${mine ? 'me' : ''} ${canSee ? '' : 'hidden'}`.trim();
  wrapper.dataset.messageId = message.id;

  wrapper.innerHTML = `
    <div>${escapeHtml(message.body)}</div>
    <div class="meta">
      <span>${new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      <span id="status-${message.id}" style="color:${color}">${statusIcon[message.status]}${message.status === 'read' ? ' (blue)' : ''}</span>
    </div>
  `;

  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateStatus(messageId, status) {
  const statusEl = document.getElementById(`status-${messageId}`);
  if (!statusEl) return;
  statusEl.textContent = `${statusIcon[status]}${status === 'read' ? ' (blue)' : ''}`;
  statusEl.style.color = status === 'read' ? 'var(--ok)' : '#bfdbfe';
}

function updatePauseUi() {
  pauseBtn.textContent = pauseAi ? 'Resume AI routing' : 'Pause AI routing';
  pauseWarning.classList.toggle('hidden', !pauseAi);
}

function validateCode(code) {
  return code.length >= 10 && /\d/.test(code);
}

async function handleCreate(code) {
  if (!validateCode(code)) {
    landingError.textContent = 'Room code must be at least 10 characters and include a number.';
    return;
  }

  const response = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });

  const payload = await response.json();
  if (!response.ok) {
    landingError.textContent = payload.error || 'Unable to create room.';
    return;
  }

  enterRoom(payload.roomCode);
}

async function handleJoin(code) {
  if (!validateCode(code)) {
    landingError.textContent = 'Room code must be at least 10 characters and include a number.';
    return;
  }

  const response = await fetch('/api/rooms/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });

  const payload = await response.json();
  if (!response.ok) {
    landingError.textContent = payload.error || 'Unable to join room.';
    return;
  }

  enterRoom(payload.roomCode);
}

function enterRoom(code) {
  roomCode = code;
  landingError.textContent = '';
  roomLabel.textContent = `Room: ${roomCode}`;
  landingScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');

  socket.emit('join-room', { roomCode, role: roleSelect.value });
  messageInput.focus();
}

function markVisibleAsRead() {
  const unreadIncoming = [...messageState.values()]
    .filter((message) => message.senderSocketId !== socket.id && message.status !== 'read')
    .filter((message) => {
      const bubble = document.querySelector(`[data-message-id="${message.id}"]`);
      return bubble && !bubble.classList.contains('hidden');
    })
    .map((message) => message.id);

  if (unreadIncoming.length > 0) {
    socket.emit('mark-read', { messageIds: unreadIncoming });
  }
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
