const socket = io();

const landingScreen = document.getElementById('landing-screen');
const chatScreen = document.getElementById('chat-screen');
const landingError = document.getElementById('landing-error');
const joinForm = document.getElementById('join-form');
const createForm = document.getElementById('create-form');
const joinCodeInput = document.getElementById('join-code');
const createCodeInput = document.getElementById('create-code');
const setupGuide = document.getElementById('setup-guide');
const setupStatus = document.getElementById('setup-status');
const roomLabel = document.getElementById('room-label');
const messagesEl = document.getElementById('messages');
const composer = document.getElementById('composer');
const messageInput = document.getElementById('message-input');
const presence = document.getElementById('presence');
const identityLabel = document.getElementById('identity-label');
const roleSelect = document.getElementById('role-select');
const pauseBtn = document.getElementById('pause-btn');
const emergencyBtn = document.getElementById('emergency-btn');
const pauseWarning = document.getElementById('pause-warning');
const interjectWarning = document.getElementById('interject-warning');
const aiReadme = document.getElementById('ai-readme');
const delayWarning = document.getElementById('delay-warning');
const toastEl = document.getElementById('toast');
const taskStateWrap = document.getElementById('task-state-wrap');
const taskStateSelect = document.getElementById('task-state');
const taskDescriptionInput = document.getElementById('task-description');

let roomCode = null;
let pauseAi = false;
let messageState = new Map();
let emergencyMode = false;
let interjectActive = false;
let pendingDelay = [];
let myDisplayName = '';
let toastTimer = null;
let roleLocked = false;
let participantId = '';
let isPrimaryHuman = false;

const STORAGE_KEY = 'aladdinChatParticipantState';

const statusIcon = {
  sent: '✓',
  delivered: '✓✓',
  read: '✓✓',
};

const taskLabels = {
  task_start: 'Task start',
  task_update: 'Task update',
  task_complete: 'Task complete',
};

function setViewportHeight() {
  const vh = (window.visualViewport?.height || window.innerHeight) * 0.01;
  document.documentElement.style.setProperty('--vh', `${vh}px`);
}

setViewportHeight();
window.visualViewport?.addEventListener('resize', setViewportHeight);
window.addEventListener('orientationchange', setViewportHeight);
setInterval(updateDelayWarning, 500);
void checkSetupStatus();
setInterval(checkSetupStatus, 20000);

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

  const currentRole = roleSelect.value;
  const taskState = currentRole === 'ai' ? taskStateSelect.value : 'none';
  const taskDescription = currentRole === 'ai' ? taskDescriptionInput.value.trim() : '';

  if (taskState !== 'none' && !taskDescription) {
    landingError.textContent = 'Please add a task description when using a task flag.';
    return;
  }

  landingError.textContent = '';
  socket.emit('send-message', {
    roomCode,
    text,
    emergencyInterject: emergencyMode,
    taskState,
    taskDescription,
  });
  messageInput.value = '';
  messageInput.focus();

  if (currentRole === 'ai') {
    taskStateSelect.value = 'none';
    taskDescriptionInput.value = '';
  }

  if (emergencyMode) {
    emergencyMode = false;
    interjectWarning.classList.add('hidden');
    emergencyBtn.textContent = 'Interject before AI sees delayed message';
  }
});

roleSelect.addEventListener('change', () => {
  if (!roomCode || roleLocked) return;
  socket.emit('set-role', { roomCode, role: roleSelect.value });
  myDisplayName = '';
  identityLabel.textContent = '';
  updateRoleUi();
  refreshMessageVisibility();
  markVisibleAsRead();
});

pauseBtn.addEventListener('click', () => {
  if (!roomCode || !isPrimaryHuman) return;
  pauseAi = !pauseAi;
  socket.emit('toggle-pause-ai', { roomCode, pauseAi });
  updatePauseUi();
});

emergencyBtn.addEventListener('click', () => {
  if (!roomCode || roleSelect.value !== 'human' || !isPrimaryHuman) return;
  emergencyMode = !emergencyMode;
  if (emergencyMode) {
    socket.emit('start-interject', { roomCode });
  }
  interjectWarning.classList.toggle('hidden', !emergencyMode);
  emergencyBtn.textContent = emergencyMode ? 'Interject armed (send next human message)' : 'Interject before AI sees delayed message';
});

socket.on('chat-history', ({ messages, pauseAi: initialPauseAi, interjectActive: activeInterject, pendingDelay: initialPendingDelay }) => {
  pauseAi = Boolean(initialPauseAi);
  interjectActive = Boolean(activeInterject);
  pendingDelay = Array.isArray(initialPendingDelay) ? initialPendingDelay : [];
  updatePauseUi();
  updateDelayWarning();
  messagesEl.innerHTML = '';
  messageState.clear();

  for (const message of messages) {
    messageState.set(message.id, message);
    renderMessage(message);
  }

  refreshMessageVisibility();
  markVisibleAsRead();
});

socket.on('message-new', (message) => {
  if (message.senderSocketId === socket.id && message.senderDisplayName) {
    myDisplayName = message.senderDisplayName;
    identityLabel.textContent = `You are ${myDisplayName}`;
  }
  messageState.set(message.id, message);
  renderMessage(message);
  refreshMessageVisibility();
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

socket.on('interject-updated', ({ active }) => {
  interjectActive = Boolean(active);
  interjectWarning.classList.toggle('hidden', !interjectActive);
});

socket.on('pending-delay-update', ({ pending }) => {
  pendingDelay = Array.isArray(pending) ? pending : [];
  updateDelayWarning();
});

socket.on('release-held-messages', ({ messageIds }) => {
  for (const id of messageIds) {
    const bubble = document.querySelector(`[data-message-id="${id}"]`);
    if (bubble) bubble.classList.remove('hidden');
  }
});

socket.on('participant-update', ({ count, participants = [] }) => {
  presence.textContent = `${count} participant${count === 1 ? '' : 's'} online`;
  const ordered = Array.isArray(participants)
    ? participants
      .map((participant) => {
        const status = participant.isOnline ? 'online' : 'offline';
        return `${participant.displayName} (${status})`;
      })
      .join(', ')
    : '';
  if (ordered) {
    identityLabel.textContent = socket.id && myDisplayName ? `You are ${myDisplayName} · In room: ${ordered}` : `In room: ${ordered}`;
  }
});


socket.on('role-locked', ({ role, displayName, isPrimaryHuman: primary }) => {
  roleLocked = true;
  isPrimaryHuman = Boolean(primary);
  roleSelect.value = role;
  roleSelect.disabled = true;
  myDisplayName = displayName || '';
  participantId = extractParticipantId(displayName || '') || participantId;
  if (roomCode && participantId) {
    persistParticipantState(roomCode, role, participantId);
  }
  identityLabel.textContent = myDisplayName ? `You are ${myDisplayName}` : '';
  updateRoleUi();
});


socket.on('role-updated', ({ socketId, displayName }) => {
  if (socketId === socket.id && displayName) {
    myDisplayName = displayName;
    identityLabel.textContent = `You are ${myDisplayName}`;
  }
});


socket.on('toast-update', ({ level = 'info', message = '' }) => {
  showToast(message, level);
});

socket.on('chat-error', (error) => {
  landingError.textContent = error;
});


socket.on('connect_error', (error) => {
  landingError.textContent = error?.message || 'Unable to connect yet. Please complete setup and refresh.';
});


function renderMessage(message) {
  const mine = message.senderSocketId === socket.id;
  const canSee = !message.heldForAi || roleSelect.value === 'human' || mine;
  const color = message.status === 'read' ? 'var(--ok)' : '#bfdbfe';
  const senderLabel = `<div class="sender">${escapeHtml(message.senderDisplayName || message.senderRole || 'Participant')}</div>`;
  const taskBadge = message.taskState && message.taskState !== 'none'
    ? `<div class="task-badge">${taskLabels[message.taskState] || message.taskState}${message.taskDescription ? ` · ${escapeHtml(message.taskDescription)}` : ''}</div>`
    : '';
  const interjectionBadge = (message.humanInterjection || message.emergencyInterject)
    ? '<div class="task-badge">HUMAN interjection</div>'
    : '';

  const wrapper = document.createElement('article');
  wrapper.className = `message ${mine ? 'me' : ''} ${canSee ? '' : 'hidden'}`.trim();
  wrapper.dataset.messageId = message.id;

  wrapper.innerHTML = `
    ${senderLabel}
    ${taskBadge}
    ${interjectionBadge}
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

function updateRoleUi() {
  const isAi = roleSelect.value === 'ai';
  aiReadme.classList.toggle('hidden', !isAi);
  pauseBtn.classList.toggle('hidden', isAi);
  emergencyBtn.classList.toggle('hidden', isAi);
  const controlsLocked = !isPrimaryHuman;
  pauseBtn.disabled = controlsLocked;
  emergencyBtn.disabled = controlsLocked;
  pauseBtn.title = controlsLocked ? 'Only the first human to join this room can use pause/interjection controls.' : '';
  emergencyBtn.title = controlsLocked ? 'Only the first human to join this room can use pause/interjection controls.' : '';
  taskStateWrap.classList.toggle('hidden', !isAi);
  taskDescriptionInput.classList.toggle('hidden', !isAi);
}

function updateDelayWarning() {
  if (pendingDelay.length === 0) {
    delayWarning.classList.add('hidden');
    delayWarning.textContent = '';
    return;
  }

  const now = Date.now();
  const soonest = Math.min(...pendingDelay.map((item) => Number(item.releaseAt)));
  const seconds = Math.max(0, Math.ceil((soonest - now) / 1000));
  delayWarning.textContent = roleSelect.value === 'human'
    ? `AI-to-AI delay active: ${pendingDelay.length} pending message${pendingDelay.length === 1 ? '' : 's'}. Human interject window: ${seconds}s.`
    : `Incoming update: ${pendingDelay.length} AI message${pendingDelay.length === 1 ? '' : 's'} waiting ${seconds}s for possible human interjection.`;
  delayWarning.classList.remove('hidden');
}


async function checkSetupStatus() {
  try {
    const response = await fetch('/api/setup-status');
    if (!response.ok) return;
    const payload = await response.json();
    const ready = Boolean(payload.ready);

    joinForm.querySelector('button').disabled = !ready;
    createForm.querySelector('button').disabled = !ready;
    joinCodeInput.disabled = !ready;
    createCodeInput.disabled = !ready;

    setupGuide.classList.toggle('hidden', ready);
    if (!ready) {
      setupStatus.textContent = payload.error
        ? `Current status: ${payload.error}`
        : 'Current status: missing database configuration.';
      landingError.textContent = 'Database setup is incomplete. Finish Supabase setup first.';
    } else {
      setupStatus.textContent = '';
      if (landingError.textContent.includes('Database setup is incomplete')) {
        landingError.textContent = '';
      }
    }
  } catch (error) {
    setupGuide.classList.remove('hidden');
    setupStatus.textContent = 'Unable to verify setup status right now. Please refresh in a moment.';
  }
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
  const participant = getStoredParticipantState(roomCode);
  participantId = participant?.clientId || '';
  roleSelect.value = participant?.role || roleSelect.value;
  landingError.textContent = '';
  roomLabel.textContent = `Room: ${roomCode}`;
  landingScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');

  roleLocked = false;
  roleSelect.disabled = false;
  isPrimaryHuman = false;
  myDisplayName = '';
  identityLabel.textContent = '';
  updateRoleUi();
  socket.emit('join-room', { roomCode, role: roleSelect.value, clientId: participantId || null });
  messageInput.focus();
}

function getStoredParticipantState(code) {
  let store = {};
  try {
    store = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    store = {};
  }

  if (store[code]?.clientId && ['human', 'ai'].includes(store[code].role)) {
    return store[code];
  }

  return null;
}

function persistParticipantState(code, role, clientId) {
  let store = {};
  try {
    store = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    store = {};
  }

  store[code] = { role, clientId };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function extractParticipantId(displayName) {
  const matched = String(displayName || '').match(/-([A-Z0-9]{5})$/);
  return matched ? matched[1] : '';
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

function refreshMessageVisibility() {
  for (const message of messageState.values()) {
    const bubble = document.querySelector(`[data-message-id="${message.id}"]`);
    if (!bubble) continue;
    const mine = message.senderSocketId === socket.id;
    const canSee = !message.heldForAi || roleSelect.value === 'human' || mine;
    bubble.classList.toggle('hidden', !canSee);
  }
}

function showToast(message, level = 'info') {
  if (!message) return;
  toastEl.textContent = message;
  toastEl.dataset.level = level;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 4500);
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
