// Offline check of the utterance splitter: feeds synthetic 48 kHz audio through
// SegmentRecorder.feed() and prints where it cuts.  Run: node test/vad-test.mjs
import { SegmentRecorder } from "../src/recorder.js";

const SR = 48000;
let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

// speech-ish: voiced tone with syllable-rate amplitude wobble, plus the room noise under it
const speech = (sec, amp, noise) =>
  Array.from({ length: sec * SR }, (_, i) => {
    const t = i / SR;
    const syll = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
    return amp * syll * Math.sin(2 * Math.PI * 180 * t) + noise * rand();
  });
const room = (sec, noise) => Array.from({ length: sec * SR }, () => noise * rand());

function run(name, parts) {
  const cuts = [];
  const r = new SegmentRecorder({ onSegment: (_blob, sec) => cuts.push(sec.toFixed(1)) });
  r.ratio = SR / 16000;
  r.srcPos = 0;
  r.pending = new Float32Array(0);
  r.recent = [];
  r.preroll = [];
  r.segment = null;
  r.loudRun = 0;
  const audio = Float32Array.from(parts.flat());
  for (let i = 0; i < audio.length; i += 4096) r.feed(audio.subarray(i, i + 4096));
  r.finish(true);
  console.log(`${name}: ${cuts.length} pieces [${cuts.join("s, ")}s]`);
}

// quiet room, two sentences with a 1 s pause
run("quiet room", [room(1, 0.002), speech(3, 0.1, 0.002), room(1, 0.002), speech(2, 0.1, 0.002), room(1, 0.002)]);
// iOS auto-gain: loud room noise (0.02) under 0.1 speech — the case that never ended before
run("boosted noise", [room(1, 0.02), speech(3, 0.1, 0.02), room(1, 0.02), speech(2, 0.1, 0.02), room(1, 0.02)]);
// far-away, quiet talker over noise
run("far talker", [room(1, 0.01), speech(3, 0.035, 0.01), room(1, 0.01), speech(3, 0.035, 0.01), room(1, 0.01)]);
// someone talks for 25 s without a real pause
run("monologue 25s", [room(1, 0.01), speech(25, 0.1, 0.01), room(1, 0.01)]);
