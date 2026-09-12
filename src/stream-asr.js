// Doubao (Volcengine) streaming speech recognition over a WebSocket.
// Words come back while the person is still talking, and the server itself decides where a
// sentence ends ("definite" utterances). Browsers can't set WebSocket headers, so the
// credentials go in the URL query, which this service accepts.

const ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";

// 4-byte frame header: [version|header size] [message type|flags] [serialization|compression] [reserved]
const FULL_CLIENT_REQUEST = 0b0001;
const AUDIO_ONLY_REQUEST = 0b0010;
const FULL_SERVER_RESPONSE = 0b1001;
const SERVER_ERROR = 0b1111;
const POS_SEQUENCE = 0b0001;
const NEG_WITH_SEQUENCE = 0b0011;
const SER_NONE = 0b0000;
const SER_JSON = 0b0001;
const GZIP = 0b0001;

function packet(type, flags, serialization, seq, payload) {
  const buf = new Uint8Array(12 + payload.length);
  const v = new DataView(buf.buffer);
  buf[0] = (0b0001 << 4) | 0b0001; // protocol v1, header = 1 × 4 bytes
  buf[1] = (type << 4) | flags;
  buf[2] = serialization << 4; // no compression
  buf[3] = 0;
  v.setInt32(4, seq);
  v.setUint32(8, payload.length);
  buf.set(payload, 12);
  return buf;
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function parse(data) {
  const b = new Uint8Array(data);
  const v = new DataView(b.buffer);
  const type = b[1] >> 4;
  const flags = b[1] & 0x0f;
  const serialization = b[2] >> 4;
  const compression = b[2] & 0x0f;
  let off = (b[0] & 0x0f) * 4;
  if (flags & 0b0001) off += 4; // sequence number
  let code = 0;
  if (type === SERVER_ERROR) {
    code = v.getUint32(off);
    off += 4;
  }
  const size = v.getUint32(off);
  off += 4;
  let payload = b.subarray(off, off + size);
  if (compression === GZIP && payload.length) payload = await gunzip(payload);
  const text = new TextDecoder().decode(payload);
  let msg = text;
  if (serialization === SER_JSON && text) {
    try {
      msg = JSON.parse(text);
    } catch {}
  }
  return { type, code, msg, last: !!(flags & 0b0010) };
}

const uuid = () =>
  crypto.randomUUID?.() ||
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (Math.random() * 16) >> (c / 4)).toString(16));

export class DoubaoStream {
  constructor({ appId, token, resourceId, onPartial, onFinal, onError, onClose }) {
    Object.assign(this, { appId, token, resourceId, onPartial, onFinal, onError, onClose });
    this.pending = []; // audio captured before the socket is ready
    this.done = new Set(); // sentences already handed over
    this.seq = 1;
    this.ready = false;
  }

  start() {
    const q = new URLSearchParams({
      api_resource_id: this.resourceId,
      api_app_key: this.appId,
      api_access_key: this.token,
      api_connect_id: uuid(),
    });
    const ws = new WebSocket(`${ENDPOINT}?${q}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      const req = {
        user: { uid: "tanpan" },
        audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
        request: {
          model_name: "bigmodel",
          enable_itn: true,
          enable_punc: true,
          enable_nonstream: false, // a second, slower pass per sentence: off, speed matters more here
          show_utterances: true,
          result_type: "single",
          end_window_size: 500, // ms of silence that ends a sentence
        },
      };
      ws.send(packet(FULL_CLIENT_REQUEST, POS_SEQUENCE, SER_JSON, 1, new TextEncoder().encode(JSON.stringify(req))));
      this.ready = true;
      this.pending.forEach((p) => this.sendPcm(p));
      this.pending = [];
    };
    ws.onmessage = async (e) => {
      if (typeof e.data === "string") return;
      let r;
      try {
        r = await parse(e.data);
      } catch {
        return;
      }
      if (r.type === SERVER_ERROR) {
        this.onError?.(r.code, typeof r.msg === "string" ? r.msg : JSON.stringify(r.msg));
      } else if (r.type === FULL_SERVER_RESPONSE && r.msg && typeof r.msg === "object") {
        this.handle(r.msg);
      }
    };
    ws.onclose = (e) => {
      this.ready = false;
      this.onClose?.(e);
    };
  }

  handle(msg) {
    const utterances = msg.result?.utterances || [];
    let partial = "";
    for (const u of utterances) {
      if (u.definite) {
        const key = `${u.start_time}|${u.end_time}`;
        if (!this.done.has(key) && u.text) {
          this.done.add(key);
          this.onFinal?.(u.text);
        }
      } else if (u.text) {
        partial += u.text;
      }
    }
    if (!utterances.length && msg.result?.text) partial = msg.result.text;
    this.onPartial?.(partial);
  }

  // float samples at 16 kHz → 16-bit PCM packets
  sendPcm(float32) {
    if (!this.ready) {
      if (this.ws?.readyState === WebSocket.CONNECTING) this.pending.push(float32);
      return;
    }
    const pcm = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const x = Math.max(-1, Math.min(1, float32[i]));
      pcm[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
    }
    this.seq++;
    this.ws.send(packet(AUDIO_ONLY_REQUEST, POS_SEQUENCE, SER_NONE, this.seq, new Uint8Array(pcm.buffer)));
  }

  stop() {
    try {
      if (this.ready) {
        this.seq++;
        this.ws.send(packet(AUDIO_ONLY_REQUEST, NEG_WITH_SEQUENCE, SER_NONE, -this.seq, new Uint8Array(0)));
      }
      // give the server a moment to send the last sentence, then close
      setTimeout(() => this.ws?.close(), 1500);
    } catch {}
    this.ready = false;
  }
}
