import { GoogleGenAI, Modality } from '@google/genai';

const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;
const CONNECT_TIMEOUT_MS = 15000;
const STABLE_OPEN_MS = 10000;
const QUICK_CLOSE_MS = 5000;

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const jittered = (delay) => Math.round(delay * (0.5 + Math.random() * 0.5));

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${payload.error}: ${payload.message}`);
  return payload;
}

export class LiveSession {
  constructor({ onState, onAudio, onInterrupted, onTranscript, onToolCall, onNote, beforeToolResponse, getScreenReport }) {
    this.handlers = { onState, onAudio, onInterrupted, onTranscript, onToolCall, onNote, beforeToolResponse, getScreenReport };
    this.session = null;
    this.state = 'idle';
    this.generation = 0;
    this.conversation = 0;
    this.openedAt = 0;
    this.sawContent = false;
    this.goAwayReceived = false;
    this.attemptUsedHandle = false;
    this.resumptionHandle = null;
    this.consecutiveFailures = 0;
    this.answeredCallIds = new Set();
    this.cancelledCallIds = new Set();
    this.inflightCalls = new Map();
    this.unsentResponses = new Map();
    this.flushing = Promise.resolve();
    this.stats = { audioChunksSent: 0, framesSent: 0, toolCalls: 0, reconnects: 0 };
  }

  setState(state) {
    this.state = state;
    this.handlers.onState(state);
  }

  invalidate() {
    this.generation += 1;
    return this.generation;
  }

  async start() {
    this.consecutiveFailures = 0;
    const generation = this.invalidate();
    const config = await (await fetch('/api/config')).json();
    if (generation !== this.generation) return;
    this.config = config;
    await this.connect();
  }

  async connect() {
    const generation = this.invalidate();
    this.openedAt = 0;
    this.sawContent = false;
    this.goAwayReceived = false;
    this.attemptUsedHandle = false;
    this.setState(this.resumptionHandle ? 'reconnecting' : 'connecting');
    let timer;
    try {
      const minted = await postJson('/api/token');
      if (generation !== this.generation) return;
      const client = new GoogleGenAI({
        apiKey: minted.token,
        ...(minted.apiVersion && { httpOptions: { apiVersion: minted.apiVersion } }),
      });
      this.attemptUsedHandle = this.resumptionHandle !== null;
      const opening = client.live.connect({
        model: this.config.model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: this.config.systemInstruction,
          tools: this.config.tools,
          sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
          contextWindowCompression: { slidingWindow: {} },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onmessage: (message) => {
            if (generation === this.generation) this.handleMessage(message);
          },
          onerror: (event) => {
            if (generation === this.generation) this.handlers.onNote(`socket error: ${event.message ?? 'unknown'}`);
          },
          onclose: (event) => {
            if (generation === this.generation) this.handleClose(event);
          },
        },
      });
      opening.then((late) => {
        if (generation !== this.generation) late.close();
      }, () => {});
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no connection after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS);
      });
      const session = await Promise.race([opening, timeout]);
      if (generation !== this.generation) return;
      this.session = session;
      this.openedAt = Date.now();
      this.setState('open');
      this.flushResponses();
    } catch (error) {
      if (generation !== this.generation) return;
      this.handlers.onNote(`connect failed: ${error.message}`);
      this.dropRejectedHandle();
      await this.retryOrGiveUp();
    } finally {
      clearTimeout(timer);
    }
  }

  async retryOrGiveUp() {
    const generation = this.invalidate();
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.handlers.onNote(`giving up after ${this.consecutiveFailures} failed connection attempts; press Start to try again`);
      this.setState('failed');
      return;
    }
    this.setState('reconnecting');
    this.stats.reconnects += 1;
    await pause(jittered(Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1))));
    if (generation === this.generation) await this.connect();
  }

  handleClose(event) {
    const lifetime = this.openedAt === 0 ? 0 : Date.now() - this.openedAt;
    const stable = this.sawContent || lifetime >= STABLE_OPEN_MS;
    this.session = null;
    this.handlers.onNote(`connection closed (${event.code ?? 'no code'}) ${event.reason ?? ''}`.trim());
    if (stable) this.consecutiveFailures = 0;
    if (this.goAwayReceived) {
      this.reconnectAfterGoAway(lifetime);
      return;
    }
    if (!stable && lifetime < QUICK_CLOSE_MS) this.dropRejectedHandle();
    this.retryOrGiveUp();
  }

  dropRejectedHandle() {
    if (!this.attemptUsedHandle) return;
    this.handlers.onNote('the resumption handle was not accepted, dropping it');
    this.resumptionHandle = null;
  }

  async reconnectAfterGoAway(lifetime) {
    const generation = this.invalidate();
    if (lifetime < QUICK_CLOSE_MS) await pause(jittered(BACKOFF_BASE_MS));
    if (generation === this.generation) await this.connect();
  }

  handleMessage(message) {
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      this.resumptionHandle = message.sessionResumptionUpdate.newHandle;
      this.attemptUsedHandle = false;
    }
    if (message.goAway) {
      this.goAwayReceived = true;
      this.handlers.onNote(`server will disconnect in ${message.goAway.timeLeft ?? 'unknown time'}, reconnecting`);
      this.session?.close();
    }
    const content = message.serverContent;
    if (content) {
      this.sawContent = true;
      if (content.interrupted) this.handlers.onInterrupted();
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) this.handlers.onAudio(part.inlineData.data);
      }
      if (content.inputTranscription?.text) this.handlers.onTranscript('you', content.inputTranscription.text);
      if (content.outputTranscription?.text) this.handlers.onTranscript('model', content.outputTranscription.text);
    }
    if (message.toolCallCancellation?.ids) {
      for (const id of message.toolCallCancellation.ids) this.cancelledCallIds.add(id);
    }
    if (message.toolCall?.functionCalls) {
      this.sawContent = true;
      this.answerToolCalls(message.toolCall.functionCalls).catch((error) => this.handlers.onNote(`tool call handling failed: ${error.message}`));
    }
  }

  executeOnce(call) {
    const running = this.inflightCalls.get(call.id);
    if (running) return running;
    const execution = this.execute(call).finally(() => this.inflightCalls.delete(call.id));
    this.inflightCalls.set(call.id, execution);
    return execution;
  }

  async execute(call) {
    this.stats.toolCalls += 1;
    const result = await this.runToolCall(call);
    try {
      this.handlers.onToolCall(call, result);
    } catch (error) {
      this.handlers.onNote(`tool call report failed: ${error.message}`);
    }
    return { id: call.id, name: call.name, response: result };
  }

  isSettled(id) {
    return this.answeredCallIds.has(id) || this.cancelledCallIds.has(id) || this.unsentResponses.has(id);
  }

  async answerToolCalls(calls) {
    const conversation = this.conversation;
    const pending = calls.filter((call) => !this.isSettled(call.id));
    const responses = await Promise.all(pending.map((call) => this.executeOnce(call)));
    if (conversation !== this.conversation) return;
    for (const response of responses) {
      if (!this.isSettled(response.id)) this.unsentResponses.set(response.id, response);
    }
    await this.flushResponses();
  }

  flushResponses() {
    this.flushing = this.flushing.then(() => this.flushOnce()).catch((error) => this.handlers.onNote(`tool response flush failed: ${error.message}`));
    return this.flushing;
  }

  async flushOnce() {
    for (const id of this.cancelledCallIds) this.unsentResponses.delete(id);
    const batch = [...this.unsentResponses.values()];
    if (batch.length === 0 || !this.session) return;
    let outgoing = batch;
    try {
      await this.handlers.beforeToolResponse?.(batch);
    } catch (error) {
      this.handlers.onNote(`pre-response step failed: ${error.message}`);
      outgoing = batch.map((entry) => ({ ...entry, response: { ...entry.response, note: `fresh frame unavailable: ${error.message}` } }));
    }
    const session = this.session;
    if (!session) return;
    const deliverable = outgoing.filter((entry) => this.unsentResponses.has(entry.id) && !this.cancelledCallIds.has(entry.id));
    if (deliverable.length === 0) return;
    try {
      session.sendToolResponse({ functionResponses: deliverable });
    } catch (error) {
      this.handlers.onNote(`tool response not sent, will retry after reconnect: ${error.message}`);
      return;
    }
    for (const entry of deliverable) {
      this.unsentResponses.delete(entry.id);
      this.answeredCallIds.add(entry.id);
    }
  }

  async runToolCall(call) {
    try {
      return await postJson('/api/tool', { name: call.name, args: call.args ?? {}, screen: this.handlers.getScreenReport?.() });
    } catch (error) {
      return { error: 'tool_request_failed', message: error.message };
    }
  }

  sendAudio(base64) {
    if (this.state !== 'open' || !this.session) return;
    this.session.sendRealtimeInput({ audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } });
    this.stats.audioChunksSent += 1;
  }

  sendFrame(base64) {
    if (this.state !== 'open' || !this.session) return;
    this.session.sendRealtimeInput({ video: { data: base64, mimeType: 'image/jpeg' } });
    this.stats.framesSent += 1;
  }

  sendText(text) {
    if (this.state !== 'open' || !this.session) throw new Error('session is not open');
    this.session.sendRealtimeInput({ text });
  }

  stop() {
    this.conversation += 1;
    this.invalidate();
    this.unsentResponses.clear();
    const session = this.session;
    this.session = null;
    session?.close();
    this.setState('closed');
  }
}
