// Checks the Doubao streaming client against a fake socket: packet layout going out,
// and parsing of plain + gzip server responses coming back.  Run: node test/stream-test.mjs
import { gzipSync } from "node:zlib";

const sent = [];
class FakeSocket {
  static CONNECTING = 0;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    FakeSocket.last = this;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(b) {
    sent.push(b);
  }
  close() {}
}
globalThis.WebSocket = FakeSocket;
const { DoubaoStream } = await import("../src/stream-asr.js");

const finals = [];
const partials = [];
const s = new DoubaoStream({
  appId: "123",
  token: "tok",
  resourceId: "volc.bigasr.sauc.duration",
  onFinal: (t) => finals.push(t),
  onPartial: (t) => partials.push(t),
  onError: (c, m) => console.log("error", c, m),
});
s.start();
s.sendPcm(new Float32Array(1600)); // before open → queued
await new Promise((r) => setTimeout(r, 10));
s.sendPcm(new Float32Array(1600).fill(0.5));

const url = new URL(FakeSocket.last.url);
console.log("query ok:", url.searchParams.get("api_app_key") === "123" && url.searchParams.get("api_resource_id") === "volc.bigasr.sauc.duration");
const hdr = (b) => [...b.slice(0, 4)].map((x) => x.toString(2).padStart(8, "0")).join(" ");
const dv = (b) => new DataView(b.buffer, b.byteOffset);
console.log("full request header:", hdr(sent[0]), "seq", dv(sent[0]).getInt32(4), "json:", new TextDecoder().decode(sent[0].slice(12)).slice(0, 60) + "…");
console.log("audio packet header:", hdr(sent[1]), "seq", dv(sent[1]).getInt32(4), "bytes", dv(sent[1]).getUint32(8));
console.log("second audio packet seq", dv(sent[2]).getInt32(4), "first sample", dv(sent[2]).getInt16(12, true));

// server responses: [v1|hs1] [type 1001|flags 0001 (has seq)] [json|none or gzip] [0] seq size payload
function serverFrame(obj, gzip) {
  let payload = Buffer.from(JSON.stringify(obj));
  if (gzip) payload = gzipSync(payload);
  const b = Buffer.alloc(12 + payload.length);
  b[0] = 0x11;
  b[1] = (0b1001 << 4) | 0b0001;
  b[2] = (0b0001 << 4) | (gzip ? 1 : 0);
  b.writeInt32BE(2, 4);
  b.writeUInt32BE(payload.length, 8);
  payload.copy(b, 12);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
}
const ws = FakeSocket.last;
await ws.onmessage({ data: serverFrame({ result: { utterances: [{ text: "今天必须", definite: false, start_time: 0, end_time: 900 }] } }, false) });
await ws.onmessage({ data: serverFrame({ result: { utterances: [{ text: "今天必须定下来。", definite: true, start_time: 0, end_time: 1800 }] } }, true) });
await ws.onmessage({ data: serverFrame({ result: { utterances: [{ text: "今天必须定下来。", definite: true, start_time: 0, end_time: 1800 }, { text: "不然涨价", definite: false, start_time: 2000, end_time: 2600 }] } }, true) });
console.log("partials:", JSON.stringify(partials));
console.log("finals:", JSON.stringify(finals));
