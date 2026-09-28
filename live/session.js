import { GoogleGenAI, Modality } from '@google/genai';

const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;

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
    this.stopping = false;
    this.resumptionHandle = null;
    this.consecutiveFailures = 0;
    this.answeredCallIds = new Set();
    this.cancelledCallIds = new Set();
    this.stats = { audioChunksSent: 0, framesSent: 0, toolCalls: 0, reconnects: 0 };
  }

  setState(state) {
    this.state = state;
    this.handlers.onState(state);
  }

  async start() {
    this.stopping = false;
    this.consecutiveFailures = 0;
    this.config = await (await fetch('/api/config')).json();
    await this.connect();
  }

  async connect() {
    this.setState(this.resumptionHandle ? 'reconnecting' : 'connecting');
    try {
      const minted = await postJson('/api/token');
      const client = new GoogleGenAI({
        apiKey: minted.token,
        ...(minted.apiVersion && { httpOptions: { apiVersion: minted.apiVersion } }),
      });
      this.session = await client.live.connect({
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
          onopen: () => {
            this.consecutiveFailures = 0;
          },
          onmessage: (message) => this.handleMessage(message),
          onerror: (event) => this.handlers.onNote(`socket error: ${event.message ?? 'unknown'}`),
          onclose: (event) => this.handleClose(event),
        },
      });
      if (!this.stopping) this.setState('open');
    } catch (error) {
      this.handlers.onNote(`connect failed: ${error.message}`);
      await this.retryOrGiveUp();
    }
  }

  async retryOrGiveUp() {
    if (this.stopping) return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.setState('error');
      return;
    }
    this.setState('reconnecting');
    this.stats.reconnects += 1;
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1));
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (!this.stopping) await this.connect();
  }

  handleClose(event) {
    this.session = null;
    if (this.stopping) {
      this.setState('closed');
      return;
    }
    this.handlers.onNote(`connection closed (${event.code ?? 'no code'}) ${event.reason ?? ''}`.trim());
    this.retryOrGiveUp();
  }

  handleMessage(message) {
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      this.resumptionHandle = message.sessionResumptionUpdate.newHandle;
    }
    if (message.goAway) {
      this.handlers.onNote(`server will disconnect in ${message.goAway.timeLeft ?? 'unknown time'}, reconnecting`);
      this.session?.close();
    }
    const content = message.serverContent;
    if (content) {
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
    if (message.toolCall?.functionCalls) this.answerToolCalls(message.toolCall.functionCalls);
  }

  async answerToolCalls(calls) {
    const responses = await Promise.all(calls.map(async (call) => {
      this.stats.toolCalls += 1;
      const result = await this.runToolCall(call);
      this.handlers.onToolCall(call, result);
      return { id: call.id, name: call.name, response: result };
    }));
    const unanswered = responses.filter((response) => !this.answeredCallIds.has(response.id) && !this.cancelledCallIds.has(response.id));
    for (const response of unanswered) this.answeredCallIds.add(response.id);
    if (unanswered.length === 0) return;
    await this.handlers.beforeToolResponse?.(unanswered);
    if (this.session) this.session.sendToolResponse({ functionResponses: unanswered });
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
    this.stopping = true;
    if (this.session) this.session.close();
    else this.setState('closed');
  }
}
