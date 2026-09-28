import { LiveSession } from './session.js';
import { createNoticeEngine } from './notices.js';
import { createPlayback, startMicrophone, startScreenShare } from './media.js';

const LOG_LIMIT = 200;
const FRAME_REBUILD_DELAY_MS = 50;
const AUTO_REBUILD_AFTER_MS = 3000;
const IDS = ['status', 'app-status', 'start', 'share', 'mute', 'refresh', 'pause', 'restore', 'rebuild', 'stop', 'log', 'say', 'say-text', 'say-send', 'frame'];
const elements = Object.fromEntries(IDS.map((id) => [id, document.getElementById(id)]));

const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'refresh_page', 'restore_last_good', 'v0_import', 'add_ui_component', 'install_packages']);
const FRAME_SETTLE_MS = 400;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
  autoRebuilt: false,
};

const alternateHost = { localhost: '127.0.0.1', '127.0.0.1': 'localhost' }[location.hostname];
const appOrigin = alternateHost ? `${location.protocol}//${alternateHost}:${location.port}` : location.origin;

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
  if (state === 'closed' || state === 'error') releaseMedia();
}

const live = new LiveSession({
  onState: applyState,
  onAudio: (base64) => runtime.playback?.enqueue(base64),
  onInterrupted: () => runtime.playback?.flush(),
  onTranscript: (speaker, text) => logLine(speaker, `${speaker}: ${text}`),
  onToolCall: (call, result) => logLine('tool', `${call.name}(${JSON.stringify(call.args ?? {}).slice(0, 120)}) -> ${result.error ?? result.status ?? 'ok'}`),
  onNote: (text) => logLine('note', text),
  getScreenReport: () => ({ sharing: runtime.screen !== null }),
  beforeToolResponse: freshFrameBeforeAnswer,
});

async function freshFrameBeforeAnswer(responses) {
  const changedApp = responses.some((entry) => MUTATING_TOOLS.has(entry.name) && !entry.response.error);
  if (!changedApp || runtime.screen === null) return;
  await sleep(FRAME_SETTLE_MS);
  const sent = await runtime.screen.captureNow();
  logLine('note', sent ? 'sent a fresh frame before the edit result' : 'could not capture a fresh frame');
}

function announceVision() {
  if (live.state !== 'open' || runtime.sharePending) return;
  const sharing = runtime.screen !== null;
  if (runtime.announcedSharing === sharing) return;
  const text = sharing
    ? 'SYSTEM NOTICE (app tooling, not the user): screen video is now shared. You receive a fresh frame of the app after every edit.'
    : 'SYSTEM NOTICE (app tooling, not the user): screen video is NOT shared, so you cannot see the app. Rely on tool results only, never claim you saw something visually, and tell the user they can click Share this tab.';
  try {
    live.sendText(text);
    runtime.announcedSharing = sharing;
    logLine('note', sharing ? 'told Gemini the screen is shared' : 'told Gemini it is blind');
  } catch (error) {
    logLine('error', `vision notice not sent: ${error.message}`);
  }
}

const notices = createNoticeEngine({
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
  live.setState('connecting');
  const sharing = share();
  runtime.playback = createPlayback();
  await runtime.playback.resume();
  try {
    runtime.microphone = await startMicrophone({ onChunk: (base64) => live.sendAudio(base64) });
  } catch (error) {
    logLine('error', `microphone unavailable: ${error.message}; text input still works`);
  }
  await live.start();
  await sharing;
}

function abortStart(error) {
  logLine('error', `start failed: ${error.message}`);
  releaseMedia();
  live.setState('idle');
}

async function share() {
  runtime.sharePending = true;
  try {
    runtime.screen = await startScreenShare({
      onFrame: (base64) => live.sendFrame(base64),
      onEnded: () => {
        runtime.screen = null;
        applyState(live.state);
        logLine('note', 'screen share ended');
        announceVision();
      },
    });
    logLine('note', 'sharing this tab');
  } catch (error) {
    logLine('error', `screen share unavailable: ${error.message}; Gemini cannot see the app`);
  } finally {
    runtime.sharePending = false;
  }
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
  if (!frameHung) {
    clearTimeout(runtime.autoRebuildTimer);
    runtime.autoRebuildTimer = null;
    runtime.autoRebuilt = false;
    return;
  }
  if (runtime.autoRebuilt || runtime.autoRebuildTimer !== null) return;
  runtime.autoRebuildTimer = setTimeout(() => {
    runtime.autoRebuildTimer = null;
    runtime.autoRebuilt = true;
    rebuildFrame();
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

const events = new EventSource('/api/events');
events.addEventListener('status', (event) => applyAppStatus(JSON.parse(event.data)));
events.addEventListener('rebuild', rebuildFrame);
events.addEventListener('error', () => {
  elements['app-status'].dataset.state = 'error';
  elements['app-status'].textContent = 'app: status offline';
});

elements.start.addEventListener('click', () => start().catch(abortStart));
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
  get microphone() { return runtime.microphone !== null; },
  get appStatus() { return runtime.appSnapshot; },
  get hmrFree() { return !performance.getEntriesByType('resource').some((entry) => /@vite\/client|@react-refresh/.test(entry.name)); },
  session: live,
};

applyState('idle');
loadFrame();
