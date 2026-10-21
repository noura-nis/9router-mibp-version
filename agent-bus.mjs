// agent-bus.mjs - Inter-Agent Collaboration & Event Bus
// Dibuat khusus untuk ekosistem AI Engineering & Research Lab
// Menghubungkan Nadia CS (@noranisa_bot), OTTEROps (@otter834_bot), dan DEVRA (@devra9920_bot)

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EVENT_LOG_FILE = path.join(__dirname, 'agent-events.json');

const listeners = new Map();

export function onAgentEvent(eventType, callback) {
  if (!listeners.has(eventType)) listeners.set(eventType, []);
  listeners.get(eventType).push(callback);
}

export function dispatchLocalEvent(payload) {
  if (!payload || !payload.type) return;
  const handlers = listeners.get(payload.type) || [];
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch (err) {
      console.warn(`[AgentBus] Handler error for ${payload.type}:`, err.message);
    }
  }
}

// Dengarkan pesan dari IPC child/parent process
if (typeof process.on === 'function') {
  process.on('message', (msg) => {
    if (msg && msg.type) {
      dispatchLocalEvent(msg);
    }
  });
}

export async function publishAgentEvent(event) {
  const payload = {
    id: 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    timestamp: new Date().toISOString(),
    ...event
  };

  // 1. Simpan ke local event log
  try {
    let events = [];
    try {
      const data = await fs.readFile(EVENT_LOG_FILE, 'utf-8');
      events = JSON.parse(data);
    } catch (e) {}
    events.unshift(payload);
    if (events.length > 50) events.pop();
    await fs.writeFile(EVENT_LOG_FILE, JSON.stringify(events, null, 2), 'utf-8');
  } catch (e) {}

  // 2. Kirim ke parent process jika ada IPC
  if (typeof process.send === 'function') {
    try {
      process.send(payload);
    } catch (e) {}
  }

  // 3. Jalankan local listeners
  dispatchLocalEvent(payload);

  // 4. Broadcast via HTTP ke service cluster kawan di Render
  const targetEndpoints = [
    'https://bansos-router.onrender.com/api/agent-event',
    'https://devra-9router.onrender.com/api/agent-event'
  ].filter(url => !event.origin || !url.includes(event.origin));

  for (const endpoint of targetEndpoints) {
    try {
      fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer bansos-internal-bus-key'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000)
      }).catch(() => {});
    } catch (e) {}
  }

  return payload;
}
