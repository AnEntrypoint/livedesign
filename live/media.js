const CAPTURE_SAMPLE_RATE = 16000;
const PLAYBACK_SAMPLE_RATE = 24000;

export function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

export async function startMicrophone({ onChunk }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  let context = null;
  let capture = null;
  let muted = false;
  try {
    context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
    await context.audioWorklet.addModule(new URL('./pcm-capture.worklet.js', import.meta.url));
    const source = context.createMediaStreamSource(stream);
    capture = new AudioWorkletNode(context, 'pcm-capture');
    const silentSink = context.createGain();
    silentSink.gain.value = 0;
    capture.port.onmessage = (event) => {
      if (!muted) onChunk(bytesToBase64(new Uint8Array(event.data)));
    };
    source.connect(capture);
    capture.connect(silentSink);
    silentSink.connect(context.destination);
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    context?.close().catch(() => {});
    throw error;
  }
  return {
    setMuted(value) {
      muted = value;
    },
    stop() {
      capture.port.onmessage = null;
      for (const track of stream.getTracks()) track.stop();
      return context.close().catch(() => {});
    },
  };
}

export function createPlayback() {
  const context = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
  const playing = new Set();
  let cursor = 0;
  return {
    resume: () => context.resume(),
    enqueue(base64) {
      const samples = base64ToInt16(base64);
      const buffer = context.createBuffer(1, samples.length, PLAYBACK_SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index += 1) channel[index] = samples[index] / 0x8000;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const startAt = Math.max(context.currentTime + 0.02, cursor);
      source.start(startAt);
      cursor = startAt + buffer.duration;
      playing.add(source);
      source.onended = () => playing.delete(source);
    },
    flush() {
      for (const source of playing) {
        source.onended = null;
        source.stop();
      }
      playing.clear();
      cursor = 0;
    },
    close: () => context.close().catch(() => {}),
  };
}

export async function startScreenShare({ onFrame, onEnded, maxWidth = 1280, intervalMs = 1000, quality = 0.7 }) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 5 } },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
  });
  const video = document.createElement('video');
  try {
    video.srcObject = stream;
    video.muted = true;
    await video.play();
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    throw error;
  }
  const canvas = document.createElement('canvas');
  const drawing = canvas.getContext('2d');
  let stopped = false;
  let timer = 0;

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  const grabFrame = async () => {
    if (stopped || video.videoWidth === 0) return null;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    drawing.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || stopped) return null;
    return { base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), size: blob.size };
  };

  const captureNow = async () => {
    const frame = await grabFrame();
    if (frame) onFrame(frame.base64, frame.size);
    return frame !== null;
  };

  const tick = async () => {
    if (stopped) return;
    await captureNow();
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  stream.getVideoTracks()[0].addEventListener('ended', () => {
    stop();
    onEnded();
  });
  tick();
  return { stop, captureNow };
}
