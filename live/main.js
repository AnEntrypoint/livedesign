import { LiveSession } from './session.js';
import { createEpisode, createNoticeEngine } from './notices.js';
import { createPlayback, startMicrophone, startScreenShare } from './media.js';

const LOG_LIMIT = 200;
const FRAME_REBUILD_DELAY_MS = 50;
const AUTO_REBUILD_AFTER_MS = 3000;
const AUTO_REBUILD_LIMIT = 3;
const EVENTS_RETRY_BASE_MS = 1000;
const EVENTS_RETRY_CAP_MS = 15000;
const IDS = ['status', 'app-status', 'start', 'share', 'mute', 'refresh', 'pause', 'restore', 'rebuild', 'stop', 'log', 'say', 'say-text', 'say-send', 'frame'];
const elements = Object.fromEntries(IDS.map((id) => [id, document.getElementById(id)]));

const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'refresh_page', 'restore_last_good', 'v0_import', 'add_ui_component', 'install_packages']);
const VALIDATE_DELAY_MS = 700;
const PROMPT_COOLDOWN_MS = 1500;

const runtime = {
  playback: null,
  microphone: null,
  screen: null,
  sharePending: false,
  announcedSharing: null,
  serverId: null,
  muted: false,
  events: [],
  appSnapshot: null,
  autoRebuildTimer: null,
  eventsRetryMs: EVENTS_RETRY_BASE_MS,
  lastFrameAt: 0,
  lastPromptAt: 0,
  epoch: 0,
};

const alternateHost = { localhost: '127.0.0.1', '127.0.0.1': 'localhost' }[location.hostname];
const appOrigin = alternateHost ? `${location.protocol}//${alternateHost}:${location.port}` : location.origin;
document.getElementById('open-app').href = `${appOrigin}/app/`;

function logLine(kind, text) {
  const item = document.createElement('li');
  item.dataset.kind = kind;
  item.textContent = text;
  elements.log.append(item);
  while (elements.log.children.length > LOG_LIMIT) elements.log.firstChild.remove();
  elements.log.scrollTop = elements.log.scrollHeight;
  runtime.events.push({ ts: Date.now(), kind, text });
  if (runtime.events.length > LOG_LIMIT) runtime.events.shift();
}

function loadFrame() {
  elements.frame.src = `${appOrigin}/app/?frame=${Date.now()}`;
}

function rebuildFrame() {
  logLine('note', 'rebuilding the app frame');
  elements.frame.src = 'about:blank';
  setTimeout(loadFrame, FRAME_REBUILD_DELAY_MS);
}

function applyState(state) {
  const open = state === 'open';
  const active = open || state === 'connecting' || state === 'reconnecting';
  elements.status.dataset.state = state;
  elements.status.textContent = state;
  elements.start.disabled = active;
  elements.stop.disabled = !active;
  elements.share.disabled = !open || runtime.screen !== null;
  elements.mute.disabled = runtime.microphone === null;
  elements['say-text'].disabled = !open;
  elements['say-send'].disabled = !open;
  if (open) {
    notices.retry();
    announceVision();
  }
  if (state === 'closed' || state === 'failed') releaseMedia();
}

const live = new LiveSession({
  onState: applyState,
  onAudio: (base64) => runtime.playback?.enqueue(base64),
  onInterrupted: () => runtime.playback?.flush(),
  onTranscript: (speaker, text) => logLine(speaker, `${speaker}: ${text}`),
  onToolCall: (call, result) => logLine('tool', `${call.name}(${JSON.stringify(call.args ?? {}).slice(0, 120)}) -> ${result.error ?? result.status ?? 'ok'}`),
  onNote: (text) => logLine('note', text),
  getScreenReport: () => ({ sharing: runtime.screen !== null }),
  beforeToolResponse: promptValidation,
});

function promptValidation(responses) {
  if (runtime.screen === null) return;
  const changed = responses.some((entry) => MUTATING_TOOLS.has(entry.name) && !entry.response.error);
  if (!changed) return;
  const now = Date.now();
  if (now - runtime.lastPromptAt < PROMPT_COOLDOWN_MS) return;
  runtime.lastPromptAt = now;
  setTimeout(() => {
    if (runtime.screen === null) return;
    try {
      live.sendText('SYSTEM NOTICE (app tooling, not the user): your change was applied and the live screen view now shows the result. Look at it and confirm the intended change is actually visible before reporting success; if it is not visible, say so plainly instead of claiming success.');
      logLine('note', 'asked Gemini to validate against the live screen view');
    } catch (error) {
      logLine('error', `validation prompt not sent: ${error.message}`);
    }
  }, VALIDATE_DELAY_MS);
}

function announceVision() {
  if (live.state !== 'open' || runtime.sharePending) return;
  const sharing = runtime.screen !== null;
  if (runtime.announcedSharing === sharing) return;
  const text = sharing
    ? 'SYSTEM NOTICE (app tooling, not the user): you are now watching a live view of the screen. Treat that live view as your primary validation: describe only what you actually see in it and never claim a visual result you have not observed.'
    : 'SYSTEM NOTICE (app tooling, not the user): screen video is NOT shared, so you cannot see the app. Rely on tool results only, never claim you saw something visually, and tell the user they can click Share this tab.';
  try {
    live.sendText(text);
    runtime.announcedSharing = sharing;
    logLine('note', sharing ? 'told Gemini the screen is shared' : 'told Gemini it is blind');
  } catch (error) {
    logLine('error', `vision notice not sent: ${error.message}`);
  }
}

const episode = createEpisode();

const notices = createNoticeEngine({
  episode,
  send: (text) => {
    try {
      live.sendText(text);
      logLine('note', `notice to Gemini: ${text.slice(0, 160)}`);
      return true;
    } catch {
      return false;
    }
  },
});

function releaseMedia() {
  runtime.epoch += 1;
  runtime.sharePending = false;
  runtime.screen?.stop();
  runtime.screen = null;
  runtime.microphone?.stop();
  runtime.microphone = null;
  runtime.playback?.close();
  runtime.playback = null;
  runtime.announcedSharing = null;
  elements.mute.setAttribute('aria-pressed', 'false');
  runtime.muted = false;
}

async function callTool(name, args = {}) {
  const response = await fetch('/api/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args }),
  });
  return response.json();
}

function summarizeToolResult(result) {
  if (result.error) return `${result.error}: ${result.message}`;
  return `${result.status ?? 'ok'}${result.hmr ? `, ${result.hmr}` : ''}${result.recovered ? ', recovered' : ''}`;
}

async function start() {
  runtime.epoch += 1;
  const epoch = runtime.epoch;
  const aborted = () => runtime.epoch !== epoch;
  live.setState('connecting');
  try {
    const sharing = share();
    const playback = createPlayback();
    runtime.playback = playback;
    await playback.resume();
    if (aborted()) return;
    let microphone = null;
    try {
      microphone = await startMicrophone({ onChunk: (base64) => live.sendAudio(base64) });
    } catch (error) {
      logLine('error', `microphone unavailable: ${error.message}; text input still works`);
    }
    if (aborted()) {
      microphone?.stop();
      return;
    }
    runtime.microphone = microphone;
    await live.start();
    await sharing;
  } catch (error) {
    if (aborted()) return;
    logLine('error', `start failed: ${error.message}`);
    live.stop();
    live.setState('idle');
  }
}

async function share() {
  const epoch = runtime.epoch;
  runtime.sharePending = true;
  try {
    const screen = await startScreenShare({
      onFrame: (base64) => {
        runtime.lastFrameAt = Date.now();
        live.sendFrame(base64);
      },
      onEnded: () => {
        if (runtime.epoch !== epoch) return;
        runtime.screen = null;
        applyState(live.state);
        logLine('note', 'screen share ended');
        announceVision();
      },
    });
    if (runtime.epoch !== epoch) {
      screen.stop();
      return;
    }
    runtime.screen = screen;
    logLine('note', 'sharing this tab');
  } catch (error) {
    if (runtime.epoch !== epoch) return;
    logLine('error', `screen share unavailable: ${error.message}; Gemini cannot see the app`);
  }
  runtime.sharePending = false;
  applyState(live.state);
  announceVision();
}

async function runManualTool(name) {
  try {
    logLine('tool', `${name} -> ${summarizeToolResult(await callTool(name))}`);
  } catch (error) {
    logLine('error', `${name} failed: ${error.message}`);
  }
}

async function togglePause() {
  const paused = runtime.appSnapshot?.editsPaused === true;
  const response = await fetch('/api/pause', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paused: !paused }),
  });
  if (!response.ok) logLine('error', `pause toggle failed: ${response.status}`);
}

function toggleMute() {
  runtime.muted = !runtime.muted;
  runtime.microphone?.setMuted(runtime.muted);
  elements.mute.setAttribute('aria-pressed', String(runtime.muted));
}

function sendText(event) {
  event.preventDefault();
  const text = elements['say-text'].value.trim();
  if (!text) return;
  elements['say-text'].value = '';
  try {
    live.sendText(text);
    logLine('you', `you: ${text}`);
  } catch (error) {
    logLine('error', `not sent: ${error.message}`);
  }
}

function watchForHungFrame(snapshot) {
  const frameHung = snapshot.pages.some((page) => page.frameName === elements.frame.name && !page.responsive);
  episode.observe({ hung: frameHung || snapshot.status === 'unresponsive', healthy: snapshot.status === 'healthy' });
  if (!frameHung) {
    clearTimeout(runtime.autoRebuildTimer);
    runtime.autoRebuildTimer = null;
    return;
  }
  if (runtime.autoRebuildTimer !== null) return;
  if (episode.used('rebuild') >= AUTO_REBUILD_LIMIT) {
    if (episode.claim('rebuild-cap-logged')) {
      logLine('error', `the app frame hung again after ${AUTO_REBUILD_LIMIT} automatic rebuilds; not rebuilding automatically, fix the loop or press Rebuild frame`);
    }
    return;
  }
  runtime.autoRebuildTimer = setTimeout(() => {
    runtime.autoRebuildTimer = null;
    if (episode.claim('rebuild', AUTO_REBUILD_LIMIT)) rebuildFrame();
  }, AUTO_REBUILD_AFTER_MS);
}

function applyAppStatus(snapshot) {
  if (runtime.serverId !== null && runtime.serverId !== snapshot.serverId) {
    logLine('note', 'dev server restarted, rebuilding the app frame');
    rebuildFrame();
  }
  runtime.serverId = snapshot.serverId;
  runtime.appSnapshot = snapshot;
  elements['app-status'].dataset.state = snapshot.status;
  elements['app-status'].textContent = snapshot.errors.length > 0 ? `app: ${snapshot.status} (${snapshot.errors.length})` : `app: ${snapshot.status}`;
  elements.pause.setAttribute('aria-pressed', String(snapshot.editsPaused));
  elements.pause.textContent = snapshot.editsPaused ? 'Resume edits' : 'Pause edits';
  watchForHungFrame(snapshot);
  notices.update(snapshot);
}

function openEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('status', (event) => {
    runtime.eventsRetryMs = EVENTS_RETRY_BASE_MS;
    applyAppStatus(JSON.parse(event.data));
  });
  source.addEventListener('rebuild', rebuildFrame);
  source.addEventListener('error', () => {
    elements['app-status'].dataset.state = 'error';
    elements['app-status'].textContent = 'app: status offline';
    if (source.readyState !== EventSource.CLOSED) return;
    setTimeout(openEvents, runtime.eventsRetryMs);
    runtime.eventsRetryMs = Math.min(EVENTS_RETRY_CAP_MS, runtime.eventsRetryMs * 2);
  });
}

elements.start.addEventListener('click', start);
elements.stop.addEventListener('click', () => live.stop());
elements.share.addEventListener('click', share);
elements.mute.addEventListener('click', toggleMute);
elements.refresh.addEventListener('click', () => runManualTool('refresh_page'));
elements.restore.addEventListener('click', () => runManualTool('restore_last_good'));
elements.rebuild.addEventListener('click', rebuildFrame);
elements.pause.addEventListener('click', () => togglePause().catch((error) => logLine('error', `pause toggle failed: ${error.message}`)));
elements.say.addEventListener('submit', sendText);

window.__debug = {
  get state() { return live.state; },
  get stats() { return { ...live.stats }; },
  get resumable() { return live.resumptionHandle !== null; },
  get events() { return [...runtime.events]; },
  get sharing() { return runtime.screen !== null; },
  get lastFrameAt() { return runtime.lastFrameAt; },
  get microphone() { return runtime.microphone !== null; },
  get appStatus() { return runtime.appSnapshot; },
  get hmrFree() { return !performance.getEntriesByType('resource').some((entry) => /@vite\/client|@react-refresh/.test(entry.name)); },
  session: live,
};

applyState('idle');
openEvents();
loadFrame();
