const CHUNK_SAMPLES = 640;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Int16Array(CHUNK_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0][0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, channel[index]));
      this.chunk[this.filled] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.filled += 1;
      if (this.filled === CHUNK_SAMPLES) {
        const outgoing = this.chunk.slice();
        this.port.postMessage(outgoing.buffer, [outgoing.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
