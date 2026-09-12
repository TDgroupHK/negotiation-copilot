// Captures the microphone as 16 kHz mono PCM, cuts it into utterances with a simple
// energy-based voice detector, and hands each utterance to `onSegment` as a WAV Blob.

const RATE = 16000;
const FRAME = 320; // 20 ms at 16 kHz

export class SegmentRecorder {
  constructor({
    onSegment,
    onState,
    onLevel,
    silenceMs = 600,
    softMs = 8000, // after this long, cut at the next dip in the voice
    maxMs = 15000, // never let one piece run longer than this
    minSpeechMs = 400,
    prerollMs = 300,
  }) {
    this.onSegment = onSegment;
    this.onState = onState || (() => {});
    this.onLevel = onLevel || (() => {});
    this.frames = 0;
    this.silenceFrames = silenceMs / 20;
    this.softFrames = softMs / 20;
    this.maxFrames = maxMs / 20;
    this.minSpeechFrames = minSpeechMs / 20;
    this.prerollFrames = prerollMs / 20;
  }

  // Must be called straight from a tap: iOS only lets an AudioContext run if it is
  // created and resumed inside the user gesture, before anything is awaited.
  start() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    const resumed = this.ctx.resume().catch(() => {});
    return this.open(resumed);
  }

  async open(resumed) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await resumed;
    if (this.ctx.state !== "running") await this.ctx.resume().catch(() => {});
    this.ratio = this.ctx.sampleRate / RATE;
    this.srcPos = 0; // fractional read position for resampling
    this.pending = new Float32Array(0); // resampled samples not yet framed

    this.recent = []; // frame levels of the last ~2 s
    this.preroll = [];
    this.segment = null; // {frames: [], loud: n, quiet: n}
    this.loudRun = 0;

    const src = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but is the most reliable capture path on iOS Safari
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.proc.onaudioprocess = (e) => this.feed(e.inputBuffer.getChannelData(0));
    src.connect(this.proc);
    this.proc.connect(this.ctx.destination); // outputs silence; needed for the node to run
    this.src = src;
  }

  stop() {
    this.finish(true);
    try {
      this.proc?.disconnect();
      this.src?.disconnect();
    } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.proc = this.src = this.stream = this.ctx = null;
  }

  // resample to 16 kHz (linear interpolation), then process 20 ms frames
  feed(input) {
    const out = [];
    // pos can start in [-1, 0): between the previous chunk's last sample and input[0]
    let pos = this.srcPos;
    const prev = this.lastSample || 0;
    while (pos < input.length - 1) {
      const i = Math.floor(pos);
      const f = pos - i;
      out.push((i < 0 ? prev : input[i]) * (1 - f) + input[i + 1] * f);
      pos += this.ratio;
    }
    this.srcPos = pos - input.length;
    this.lastSample = input[input.length - 1];
    const merged = new Float32Array(this.pending.length + out.length);
    merged.set(this.pending);
    merged.set(out, this.pending.length);
    let off = 0;
    for (; off + FRAME <= merged.length; off += FRAME) this.frame(merged.slice(off, off + FRAME));
    this.pending = merged.slice(off);
  }

  frame(f) {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / f.length);
    if (!Number.isFinite(rms)) return; // never let one bad frame poison the levels

    // Background level = the quietest moment of the last ~2 s. iOS boosts room noise
    // (auto gain), so a fixed threshold never sees a pause; this follows it instead.
    this.recent.push(rms);
    if (this.recent.length > 100) this.recent.shift();
    const floor = Math.min(...this.recent);
    const base = Math.max(floor * 3, 0.003);

    const s = this.segment;
    if (++this.frames % 10 === 0) this.onLevel(rms, s ? s.frames.length / 50 : 0); // ~5 times a second

    if (!s) {
      this.preroll.push(f);
      if (this.preroll.length > this.prerollFrames) this.preroll.shift();
      this.loudRun = rms > base ? this.loudRun + 1 : 0;
      if (this.loudRun >= 3) {
        this.segment = { frames: this.preroll.slice(), loud: this.loudRun, quiet: 0, voice: Math.max(rms, base * 2) };
        this.preroll = [];
        this.onState("speaking");
      }
      return;
    }

    s.frames.push(f);
    // a pause = clearly quieter than this speaker's own voice, not just below a fixed level
    const quietBelow = Math.max(base, s.voice * 0.3);
    if (rms > quietBelow) {
      s.loud++;
      s.quiet = 0;
      s.voice = s.voice * 0.9 + rms * 0.1;
    } else {
      s.quiet++;
    }
    const len = s.frames.length;
    if (
      s.quiet >= this.silenceFrames ||
      (len >= this.softFrames && rms < s.voice * 0.45) || // long stretch: cut at a dip
      len >= this.maxFrames
    ) {
      this.finish(false);
    }
  }

  finish(final) {
    const s = this.segment;
    this.segment = null;
    this.loudRun = 0;
    if (!s) return;
    this.onState(final ? "stopped" : "idle");
    if (s.loud < this.minSpeechFrames) return; // a cough, a door, a click
    const pcm = new Float32Array(s.frames.length * FRAME);
    s.frames.forEach((fr, i) => pcm.set(fr, i * FRAME));
    this.onSegment(encodeWav(pcm), pcm.length / RATE);
  }
}

function encodeWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
