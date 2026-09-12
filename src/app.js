import Anthropic from "@anthropic-ai/sdk";
import { SegmentRecorder } from "./recorder.js";
import { DoubaoStream } from "./stream-asr.js";

// ---------- storage ----------
const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem("nc." + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("nc." + k, JSON.stringify(v));
    } catch {}
  },
};

const MODELS = {
  "claude-opus-5": { label: "Opus 5（最聪明）", inPrice: 5, outPrice: 25, effort: true, fallbacks: true },
  "claude-sonnet-5": { label: "Sonnet 5（更快）", inPrice: 2, outPrice: 10, effort: true },
  "claude-haiku-4-5": { label: "Haiku 4.5（最快）", inPrice: 1, outPrice: 5 },
};

const settings = Object.assign(
  {
    provider: "zhipu", // "zhipu" (free GLM) | "anthropic" (Claude API)
    zhipuKey: "",
    zhipuModel: "glm-4.7-flash",
    asr: "doubao", // speech-to-text: "doubao" | "siliconflow" (free) | "zhipu" (paid) | "browser" (phone built-in)
    dbAppId: "",
    dbToken: "",
    sfKey: "",
    sfModel: "FunAudioLLM/SenseVoiceSmall",
    apiKey: "",
    baseURL: "",
    model: "claude-opus-5",
    effort: "low",
    lang: "zh-CN",
    minChars: 4,
    speak: false,
  },
  LS.get("settings", {}),
);
const prep = Object.assign({ me: "", goal: "", them: "", notes: "" }, LS.get("prep", {}));

// v2: advice should follow every caption, so drop the old 12-character wait
if (LS.get("settingsVersion", 1) < 2) {
  if (settings.minChars === 12) settings.minChars = 4;
  LS.set("settings", settings);
  LS.set("settingsVersion", 2);
}

const state = {
  listening: false,
  startedAt: 0,
  transcript: LS.get("transcript", []), // {at, text, manual?}
  advice: LS.get("advice", []), // {at, kind, text, say, manual?}
  analyzedCount: 0, // transcript entries already analyzed
  inFlight: null,
  pending: false,
  dictation: false, // using the iOS keyboard's dictation instead of the page's own speech recognition
  lastAutoAt: 0,
  autoPausedUntil: 0,
  usage: LS.get("usage", { calls: 0, cost: 0 }),
};
state.analyzedCount = state.transcript.length;

const $ = (s) => document.querySelector(s);

// ---------- backend ----------
// Opened inside Claude (as an Artifact): use the viewer's own Claude account via `sample`.
// Opened anywhere else: use the API key from settings.
let sample = null;
let sampleBlocked = false;
const sampleReady = window.claude?.use
  ? window.claude.use("sample").then(
      (s) => (sample = s),
      () => null,
    )
  : Promise.resolve(null);

const usingAccount = () => !!sample && !sampleBlocked;
const hasKey = () =>
  settings.provider === "zhipu" ? !!settings.zhipuKey : !!(settings.apiKey || settings.baseURL.trim());

const ZHIPU_MODELS = {
  "glm-4.7-flash": "GLM-4.7-Flash（免费，推荐）",
  "glm-4-flash-250414": "GLM-4-Flash（免费，更快）",
};

function client() {
  return new Anthropic({
    apiKey: settings.apiKey || "none",
    baseURL: settings.baseURL.trim() || undefined,
    dangerouslyAllowBrowser: true, // key is the user's own, stored only on this device
    maxRetries: 1,
  });
}

function systemPrompt(manual) {
  const ctx = [
    prep.me && `我是谁、我的目标：${prep.me}`,
    prep.goal && `我的底线 / 可让步空间：${prep.goal}`,
    prep.them && `对方情况：${prep.them}`,
    prep.notes && `其他注意事项：${prep.notes}`,
  ]
    .filter(Boolean)
    .join("\n");

  const base = `你是用户的实时谈判参谋。用户正在和对方当面交谈，你看到的是手机语音转写：可能有错别字、同音字，而且没有标注是谁在说话——请根据内容和用户背景推断哪些是对方说的。你的建议会显示在用户手机上或播到耳机里，用户只能瞄一眼，所以必须极短、能立刻照做。

用户背景：
<背景>
${ctx || "（用户没有填写背景，请根据对话本身判断）"}
</背景>

重点关注：对方的让步信号和真实关切、施压手段（虚假截止期限、"别家更便宜"、上级不同意等）、锚定报价、前后矛盾、没说出口的利益；以及用户自己是否在过早让步、泄露底线或被牵着走。`;

  if (manual) {
    return (
      base +
      `

用户刚刚按了"现在怎么办？"，需要你对整段对话做一次判断。按下面的格式输出，不要写其他内容：
【局势】一句话概括当前形势（不超过 25 字）
- 行动建议（每条不超过 25 字，最多 3 条）
说：「用户下一句可以直接说的话，不超过 30 字」`
    );
  }
  return (
    base +
    `

输出规则：
- 每次有新内容都要主动给用户一条当下最有用的提示：对方话里的信号、该追问什么、下一步怎么说。和之前的提醒意思相同时，换成推进一步的建议，不要重复。
- 只有最新内容完全没有信息（只是"嗯""喂""好的"之类，或识别出的是杂音）时，才只输出：PASS
- 输出 1~2 行，不要写其他任何内容：
第 1 行：【类型】建议。类型只能是 警惕 / 机会 / 追问 / 策略 之一，建议不超过 20 字。
第 2 行（可选）：说：「用户可以直接说的一句话，不超过 30 字」`
  );
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function userContent(manual) {
  const t0 = state.transcript[0]?.at ?? Date.now();
  const line = (e) => `[${fmtTime(e.at - t0)}]${e.manual ? "（用户手动补充）" : ""} ${e.text}`;
  const older = state.transcript.slice(0, state.analyzedCount);
  const fresh = state.transcript.slice(state.analyzedCount);

  // keep the prompt small: last ~3500 chars of earlier conversation
  let olderText = older.map(line).join("\n");
  if (olderText.length > 1500) olderText = "…" + olderText.slice(-1500); // shorter prompt = faster answer

  const prev = state.advice
    .slice(0, 6)
    .map((a) => `- 【${a.kind}】${a.text}`)
    .join("\n");

  return [
    prev && `【你之前给过的提醒（不要重复）】\n${prev}`,
    `【之前的对话】\n${olderText || "（无）"}`,
    manual ? `【最新内容】\n${fresh.map(line).join("\n") || "（无新内容）"}` : `【最新新增内容——重点看这里】\n${fresh.map(line).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseAdvice(text, manual) {
  const lines = text
    .trim()
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length || /^PASS/i.test(lines[0])) return null;
  const sayLine = lines.find((l) => /^说[:：]/.test(l));
  const say = sayLine ? sayLine.replace(/^说[:：]\s*/, "").replace(/^「|」$/g, "") : "";
  const m = lines[0].match(/^【(.+?)】\s*(.*)$/);
  const kind = m ? m[1] : manual ? "局势" : "策略";
  const head = m ? m[2] : lines[0];
  const rest = lines.slice(1).filter((l) => l !== sayLine);
  return { kind, text: [head, ...rest].join("\n"), say };
}

// Zhipu GLM (OpenAI-style chat completions, SSE stream). Its API allows browser (CORS) calls.
async function runZhipu(manual, signal, onText) {
  const res = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.zhipuKey },
    body: JSON.stringify({
      model: settings.zhipuModel in ZHIPU_MODELS ? settings.zhipuModel : "glm-4.7-flash",
      stream: true,
      thinking: { type: manual ? "enabled" : "disabled" },
      max_tokens: manual ? 4000 : 150,
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt(manual) },
        { role: "user", content: userContent(manual) },
      ],
    }),
  });
  if (!res.ok) {
    let body = {};
    try {
      body = await res.json();
    } catch {}
    const zcode = String(body?.error?.code ?? "");
    if (zcode === "1301") return { text: "", refused: true }; // content filter
    throw { zhipu: true, status: res.status, zcode, message: body?.error?.message || "" };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onText(text);
        }
      } catch {}
    }
  }
  state.usage.calls += 1;
  return { text, refused: false };
}

// One model call. Resolves {text, refused}; rejects with the backend's own error.
async function runModel(manual, signal, onText) {
  if (!usingAccount() && settings.provider === "zhipu") return runZhipu(manual, signal, onText);
  if (usingAccount()) {
    try {
      const { text } = await sample(systemPrompt(manual) + "\n\n" + userContent(manual), {
        modelTier: manual ? "default" : "quick",
        cache: false,
        signal,
        onText: ({ text }) => onText(text),
      });
      state.usage.calls += 1;
      return { text, refused: false };
    } catch (e) {
      if (e?.code === "refused") return { text: "", refused: true };
      throw e;
    }
  }

  const m = MODELS[settings.model] || MODELS["claude-opus-5"];
  const params = {
    model: settings.model in MODELS ? settings.model : "claude-opus-5",
    max_tokens: manual ? 4000 : 2000,
    system: systemPrompt(manual),
    messages: [{ role: "user", content: userContent(manual) }],
  };
  if (m.effort) params.output_config = { effort: manual ? "medium" : settings.effort };
  if (m.fallbacks) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  let text = "";
  const stream = client().beta.messages.stream(params, { signal });
  stream.on("text", (delta) => {
    text += delta;
    onText(text);
  });
  const msg = await stream.finalMessage();
  const u = msg.usage || {};
  state.usage.calls += 1;
  state.usage.cost += ((u.input_tokens || 0) * m.inPrice + (u.output_tokens || 0) * m.outPrice) / 1e6;
  return { text, refused: msg.stop_reason === "refusal" };
}

async function analyze(manual = false) {
  if (!usingAccount() && !hasKey()) {
    showNotice(sampleBlocked ? "没有获得使用你 Claude 账号的授权。刷新页面，在弹窗里选择允许" : "请先在「设置」里填写 API Key");
    if (!sampleBlocked) openSheet("setSheet");
    return;
  }
  if (!manual) {
    if (state.transcript.length === state.analyzedCount) return;
    if (Date.now() < state.autoPausedUntil) return;
    const wait = state.lastAutoAt + (usingAccount() ? 6000 : 1000) - Date.now();
    if (wait > 0) return scheduleAnalyze(wait);
  }

  if (state.inFlight) {
    if (!manual) {
      state.pending = true;
      return;
    }
    state.inFlight.abort();
  }

  const ctl = new AbortController();
  state.inFlight = ctl;
  if (!manual) state.lastAutoAt = Date.now();
  const upTo = state.transcript.length;

  setThinking(true, manual);
  try {
    const { text, refused } = await runModel(manual, ctl.signal, (soFar) => {
      if (ctl.signal.aborted) return;
      // don't flash anything while the reply might still turn out to be "PASS"
      if (!manual && "PASS".startsWith(soFar.trim().slice(0, 4).toUpperCase())) return;
      const a = parseAdvice(soFar, manual);
      if (a) renderCard({ ...a, at: Date.now(), manual, streaming: true });
    });
    state.analyzedCount = Math.max(state.analyzedCount, upTo);
    LS.set("usage", state.usage);

    const a = refused ? null : parseAdvice(text, manual);
    if (refused && manual) showNotice("Claude 这次没有回答，换个说法再试");
    if (a) {
      const item = { ...a, at: Date.now(), manual };
      state.advice.unshift(item);
      state.advice = state.advice.slice(0, 50);
      LS.set("advice", state.advice);
      renderCard(item);
      const card = $("#card");
      card.classList.remove("fresh");
      void card.offsetWidth; // restart the highlight animation
      card.classList.add("fresh");
      renderHistory();
      speak(a.say ? `${a.text}。可以说：${a.say}` : a.text);
    } else {
      renderCard(state.advice[0] || null);
    }
  } catch (err) {
    if (ctl.signal.aborted || err?.code === "cancelled") return;
    showNotice(errorText(err));
    renderCard(state.advice[0] || null);
  } finally {
    if (state.inFlight === ctl) {
      state.inFlight = null;
      setThinking(false);
      renderMeta();
      if (state.pending) {
        state.pending = false;
        scheduleAnalyze(0);
      }
    }
  }
}

function errorText(err) {
  if (err?.zhipu) {
    if (err.status === 401) return "智谱 API Key 无效，请到「设置」检查";
    if (err.status === 429) {
      state.autoPausedUntil = Date.now() + 20000;
      return "智谱免费版正在限流（下午到晚上高峰期常见），自动提醒暂停 20 秒后继续";
    }
    return `智谱出错（${err.status}${err.zcode ? " / " + err.zcode : ""}）：${(err.message || "").slice(0, 60)}`;
  }
  if (err instanceof TypeError) return "连不上 AI 服务器，请检查网络";

  // Claude-account errors are plain {code, message} objects
  switch (err?.code) {
    case "not_granted":
    case "sampling_disabled":
    case "not_declared":
    case "capability_disabled":
    case "capability_removed":
      sampleBlocked = true;
      applyBackendUI();
      return "没有获得使用你 Claude 账号的授权，自动提醒已停止。刷新页面，在弹窗里选择允许";
    case "rate_limited":
      state.autoPausedUntil = Date.now() + 60000;
      return "Claude 用量暂时到上限了，自动提醒暂停 1 分钟；「现在怎么办？」稍后可以再点";
    case "session_expired":
      return "Claude 登录已过期，请重新登录后刷新页面";
    case "prompt_too_large":
      return "这场对话太长了，请在「设置」里点「清空本场」后继续";
  }
  if (err?.code) return "Claude 暂时出错，稍后再试";

  if (err instanceof Anthropic.AuthenticationError) return "API Key 无效，请到「设置」检查";
  if (err instanceof Anthropic.PermissionDeniedError) return "这个 API Key 没有权限使用所选模型";
  if (err instanceof Anthropic.NotFoundError) return "模型不存在或 API 地址不对，请检查设置";
  if (err instanceof Anthropic.RateLimitError) return "请求太频繁或额度用完，稍后再试";
  if (err instanceof Anthropic.BadRequestError) return "请求被拒（400）：" + (err.message || "").slice(0, 80);
  if (err instanceof Anthropic.APIConnectionError) return "连不上 Claude 服务器，请检查网络";
  if (err instanceof Anthropic.APIError) return `Claude 出错（${err.status ?? "?"}），稍后再试`;
  return "出错了：" + (err?.message || String(err)).slice(0, 80);
}

let analyzeTimer = 0;
function scheduleAnalyze(delay = 700) {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(() => {
    const fresh = state.transcript.slice(state.analyzedCount);
    const chars = fresh.reduce((n, e) => n + e.text.length, 0);
    if (chars >= settings.minChars || fresh.some((e) => e.manual)) analyze(false);
  }, delay);
}

// ---------- cloud speech-to-text ----------
// The page records each utterance itself (recorder.js) and sends it as a WAV to a
// transcription API — far more accurate than the phone's built-in web recognition.
const ASR = {
  "doubao-stream": {
    name: "豆包流式",
    key: () => settings.dbAppId && settings.dbToken,
  },
  doubao: {
    name: "豆包语音",
    url: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
    key: () => settings.dbAppId && settings.dbToken,
  },
  siliconflow: {
    name: "硅基流动",
    url: "https://api.siliconflow.cn/v1/audio/transcriptions",
    get model() {
      return settings.sfModel || "FunAudioLLM/SenseVoiceSmall";
    },
    key: () => settings.sfKey,
  },
  zhipu: {
    name: "智谱 GLM-ASR",
    url: "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions",
    model: "glm-asr-2512",
    key: () => settings.zhipuKey,
  },
};
const activeAsr = () => (ASR[settings.asr]?.key() ? settings.asr : "browser");

let recorder = null;
let asrChain = Promise.resolve();
let asrFailed = false;
let asrBusy = 0;

let partialSeq = 0;
let partialBusy = false;

function transcribeLater(blob) {
  // one request at a time keeps sentences in order
  asrBusy++;
  partialSeq++; // any preview still in flight is now out of date
  asrChain = asrChain
    .then(() => transcribe(blob))
    .catch(() => {})
    .finally(() => {
      asrBusy--;
      if (!asrBusy) renderPartial("");
    });
}

// Live caption preview: while someone is still talking, recognise what has been said so
// far and show it greyed out; the final result for the sentence replaces it.
function previewPartial(blob) {
  if (partialBusy || asrBusy || asrFailed || !state.listening) return; // finals come first
  partialBusy = true;
  const seq = ++partialSeq;
  recognizeQuietly(blob)
    .then((text) => seq === partialSeq && state.listening && text && renderPartial(text + " …"))
    .catch(() => {})
    .finally(() => (partialBusy = false));
}

async function recognizeQuietly(blob) {
  const id = activeAsr();
  if (id === "doubao") return (await transcribeDoubao(blob)).trim();
  const p = ASR[id];
  if (!p) return "";
  const fd = new FormData();
  fd.append("model", p.model);
  fd.append("file", blob, "speech.wav");
  const res = await fetch(p.url, { method: "POST", headers: { Authorization: "Bearer " + p.key() }, body: fd });
  if (!res.ok) return "";
  const json = await res.json().catch(() => ({}));
  return cleanAsrText(json.text);
}

// SenseVoice can add tags like <|zh|><|NEUTRAL|> and emotion/event emoji; keep only the words
function cleanAsrText(t) {
  return String(t || "")
    .replace(/<\|[^|]*\|>/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .trim();
}

const blobToBase64 = (blob) =>
  new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1]);
    r.onerror = fail;
    r.readAsDataURL(blob);
  });
const uuid = () =>
  crypto.randomUUID?.() ||
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (Math.random() * 16) >> (c / 4)).toString(16));

let dbNoContext = false; // set if the service ever rejects the context field

// Doubao (Volcengine) flash recognition. Only the APP ID + Access Token header pair passes
// the service's CORS rules; the newer single X-Api-Key header is blocked in browsers.
async function transcribeDoubao(blob, retry = false) {
  const request = { model_name: "bigmodel", enable_itn: true, enable_punc: true };
  if (!dbNoContext) {
    // background terms + the last few sentences help with names, numbers and jargon
    const hints = [prep.me, prep.goal, prep.them, prep.notes, ...state.transcript.slice(-5).map((e) => e.text)]
      .filter(Boolean)
      .join("\n")
      .slice(-800);
    if (hints) request.corpus = { context: JSON.stringify({ contextData: [{ text: hints }] }) };
  }
  const res = await fetch(ASR.doubao.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-App-Key": settings.dbAppId,
      "X-Api-Access-Key": settings.dbToken,
      "X-Api-Resource-Id": "volc.bigasr.auc_turbo",
      "X-Api-Request-Id": uuid(),
      "X-Api-Sequence": "-1",
    },
    body: JSON.stringify({ user: { uid: "tanpan" }, audio: { data: await blobToBase64(blob), format: "wav" }, request }),
  });
  const status = res.headers.get("X-Api-Status-Code") || "";
  const json = await res.json().catch(() => ({}));
  if (res.ok && (!status || status === "20000000")) return String(json?.result?.text || "");
  if (status === "20000003") return ""; // silence
  if (status.startsWith("45000") && status !== "45000010" && request.corpus && !retry) {
    dbNoContext = true; // parameter problem: try once more without the context hints
    return transcribeDoubao(blob, true);
  }
  throw { doubao: true, status: res.status, code: status, message: res.headers.get("X-Api-Message") || json?.header?.message || "" };
}

async function transcribe(blob) {
  const id = activeAsr();
  const p = ASR[id];
  if (!p || asrFailed) return;
  if (id === "doubao") {
    if (state.listening) renderLive("识别中…");
    try {
      const text = (await transcribeDoubao(blob)).trim();
      if (text) commit(text);
      else if (state.listening) renderLive("");
    } catch (err) {
      if (!err?.doubao) {
        showNotice("语音识别连不上服务器，请检查网络");
      } else if (err.code === "45000010" || err.status === 401) {
        asrFailed = true;
        stopListening();
        showNotice("豆包语音的 APP ID 或 Access Token 不对，请到「设置」检查");
      } else if (err.status === 403 || err.status === 429) {
        showNotice(`豆包语音：${err.message || "额度用完或请求太频繁"}（${err.code || err.status}）`);
      } else {
        showNotice(`豆包语音出错（${err.code || err.status}）：${err.message.slice(0, 60)}`);
      }
    }
    return;
  }
  const fd = new FormData();
  fd.append("model", p.model);
  fd.append("file", blob, "speech.wav");
  if (id === "zhipu") {
    // the previous sentences help GLM-ASR with names and context
    const ctx = state.transcript.slice(-8).map((e) => e.text).join(" ");
    if (ctx) fd.append("prompt", ctx.slice(-500));
  }
  if (state.listening) renderLive("识别中…");
  let res;
  try {
    res = await fetch(p.url, { method: "POST", headers: { Authorization: "Bearer " + p.key() }, body: fd });
  } catch {
    showNotice("语音识别连不上服务器，请检查网络");
    return;
  }
  if (!res.ok) {
    let body = {};
    try {
      body = await res.json();
    } catch {}
    const code = String(body?.error?.code ?? body?.code ?? "");
    if (res.status === 401) {
      asrFailed = true;
      stopListening();
      showNotice(`${p.name} 的 API Key 无效，请到「设置」检查`);
    } else if (code === "1113" || res.status === 402) {
      asrFailed = true;
      stopListening();
      showNotice(`${p.name} 账户余额不足。可以在「设置」里把「语音识别」换成免费的硅基流动`);
    } else if (res.status === 429) {
      showNotice("语音识别请求太频繁，这一句可能漏掉了");
    } else {
      showNotice(`语音识别出错（${res.status}${code ? " / " + code : ""}）`);
    }
    return;
  }
  const json = await res.json().catch(() => ({}));
  const text = cleanAsrText(json.text);
  if (text) commit(text);
  else if (state.listening) renderLive("");
}

// ---------- Doubao streaming ----------
let stream = null;
let streamErrors = [];
// which streaming product the app's trial is on isn't visible from here: try 1.0, then 2.0
const STREAM_RESOURCES = ["volc.bigasr.sauc.duration", "volc.seedasr.sauc.duration"];
let streamRes = LS.get("streamRes", STREAM_RESOURCES[0]);

function joinFloat(chunks) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function openStream() {
  const s = new DoubaoStream({
    appId: settings.dbAppId,
    token: settings.dbToken,
    resourceId: streamRes,
    onPartial: (t) => stream === s && renderPartial(t ? t + " …" : ""),
    onFinal: (t) => stream === s && commit(t),
    onError: (code, msg) => {
      if (stream !== s) return;
      // not entitled to this resource → try the other streaming product once
      if (/resource|not granted|permission/i.test(String(msg)) && !s.triedOther) {
        streamRes = STREAM_RESOURCES.find((r) => r !== streamRes);
        LS.set("streamRes", streamRes);
        stream = null;
        s.stop();
        openStream();
        stream.triedOther = true;
        return;
      }
      const now = Date.now();
      streamErrors = streamErrors.filter((t) => now - t < 20000).concat(now);
      if (/grant not found|45000010|access key|app key/i.test(`${code} ${msg}`) || streamErrors.length >= 3) {
        asrFailed = true;
        stopListening();
        showNotice(`豆包流式识别连不上（${code}）：${String(msg).slice(0, 80)}。请检查 APP ID / Access Token，以及控制台里「流式语音识别大模型」是否已开通试用`);
      } else {
        showNotice(`豆包流式识别出错（${code}）：${String(msg).slice(0, 80)}`);
      }
    },
    onClose: () => {
      // the server ends sessions now and then; keep listening with a fresh one
      if (stream === s && state.listening && !asrFailed) setTimeout(() => stream === s && state.listening && openStream(), 300);
    },
  });
  stream = s;
  s.start();
}

async function startCloudListening() {
  asrFailed = false;
  state.listening = true;
  if (!state.startedAt) state.startedAt = Date.now();
  primeSpeech();
  keepAwake();
  renderStatus();
  let lastLevel = 0;
  const streaming = activeAsr() === "doubao-stream";
  let pcmBuf = [];
  const rec = new SegmentRecorder({
    // streaming: the server finds sentence ends itself, so only raw audio is needed here
    onSegment: streaming ? () => {} : transcribeLater,
    onPartial: streaming ? undefined : previewPartial,
    onPcm: streaming
      ? (f) => {
          pcmBuf.push(f);
          if (pcmBuf.length >= 5) {
            stream?.sendPcm(joinFloat(pcmBuf)); // 100 ms per packet
            pcmBuf = [];
          }
        }
      : undefined,
    onLevel: (rms, speakingSec) => {
      const speaking = speakingSec > 0;
      if (!state.listening || recorder !== rec) return;
      lastLevel = Date.now();
      // a small meter so it's obvious the phone is hearing something
      const bars = "▁▂▃▄▅▆▇█";
      const n = Math.max(0, Math.min(7, Math.round(Math.log10(Math.max(rms, 1e-4) / 1e-3) * 3.5)));
      const meter = bars.slice(0, n + 1);
      const label = speaking ? `正在听 ${Math.floor(speakingSec)}秒` : asrBusy ? "识别中" : "在听";
      renderLive(`${label} ${meter}`);
    },
  });
  recorder = rec;
  if (streaming) {
    streamErrors = [];
    openStream();
  }
  try {
    await rec.start(); // called synchronously from the tap (see recorder.js)
    // if no audio arrives at all, the microphone is not really running
    setTimeout(() => {
      if (state.listening && recorder === rec && !lastLevel) {
        showNotice(`收不到麦克风声音（音频状态：${rec.ctx?.state || "无"}）。请点「暂停」再点「继续监听」；还不行就刷新页面`);
      }
    }, 4000);
  } catch (err) {
    recorder = null;
    stopListening();
    if (err?.name === "NotAllowedError") {
      showNotice("没有麦克风权限：请在 iPhone 设置 → Safari → 麦克风 中允许，然后刷新页面");
    } else {
      enterDictation();
      showNotice("这里不能直接收音，已换成键盘听写：点上方输入框，再点键盘上的 🎤 麦克风");
    }
  }
}

// ---------- phone built-in speech recognition ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let silenceTimer = 0;
let interim = "";

function commit(text, manual = false) {
  text = text.trim();
  if (!text) return;
  state.transcript.push({ at: Date.now(), text, manual });
  LS.set("transcript", state.transcript.slice(-400));
  renderPartial("");
  renderTranscript();
  scheduleAnalyze(0);
}

function startRecognizer() {
  const r = new SR();
  rec = r;
  r.lang = settings.lang;
  r.continuous = true;
  r.interimResults = true;
  let finalIdx = 0;

  r.onresult = (e) => {
    if (rec !== r) return;
    let partial = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) {
        if (i >= finalIdx) {
          commit(res[0].transcript);
          finalIdx = i + 1;
        }
      } else {
        partial += res[0].transcript;
      }
    }
    interim = partial;
    renderPartial(interim);
    // iOS Safari often never marks results final in continuous mode:
    // treat a pause (or a very long run) as the end of a sentence, then restart.
    clearTimeout(silenceTimer);
    if (interim) {
      const flush = () => {
        if (rec !== r) return;
        commit(interim);
        interim = "";
        restartRecognizer();
      };
      if (interim.length > 150) flush();
      else silenceTimer = setTimeout(flush, 1300);
    }
  };

  r.onerror = (e) => {
    if (rec !== r) return;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      stopListening();
      enterDictation();
      showNotice("这里不能直接收音，已换成键盘听写：点上方输入框，再点键盘上的 🎤 麦克风");
    } else if (e.error === "network") {
      showNotice("语音识别需要联网，网络不通");
    } else if (e.error === "language-not-supported") {
      stopListening();
      showNotice("这台设备不支持所选识别语言");
    }
    // "no-speech" / "aborted": onend will restart
  };

  r.onend = () => {
    if (rec !== r || !state.listening) return;
    setTimeout(() => state.listening && rec === r && startRecognizer(), 150);
  };

  try {
    r.start();
  } catch {}
}

function restartRecognizer() {
  const old = rec;
  rec = null;
  try {
    old?.abort();
  } catch {}
  if (state.listening) setTimeout(() => state.listening && !rec && startRecognizer(), 120);
}

let wakeLock = null;
async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.listening) {
    keepAwake();
    if (recorder) recorder.ctx?.resume().catch(() => {});
    else restartRecognizer();
  }
});

function startListening() {
  // ask for the Claude-account permission on this tap, not in the middle of the conversation
  if (usingAccount()) window.claude.use("permissions").then((p) => p?.request(["sample"]), () => null);
  if (!state.dictation && activeAsr() !== "browser" && navigator.mediaDevices?.getUserMedia) {
    startCloudListening();
    return;
  }
  if (state.dictation || !SR) {
    enterDictation();
    $("#dictArea").focus(); // inside the tap, so iOS opens the keyboard
    return;
  }
  state.listening = true;
  if (!state.startedAt) state.startedAt = Date.now();
  primeSpeech();
  keepAwake();
  startRecognizer();
  renderStatus();
}

function stopListening() {
  state.listening = false;
  clearTimeout(silenceTimer);
  if (interim) {
    commit(interim);
    interim = "";
  }
  const old = rec;
  rec = null;
  try {
    old?.stop();
  } catch {}
  const r = recorder;
  recorder = null;
  r?.stop(); // hands over the sentence in progress
  const st = stream;
  stream = null;
  st?.stop();
  renderPartial("");
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  renderLive("");
  renderStatus();
}

// ---------- keyboard dictation ----------
// Where the page can't reach the microphone (e.g. inside Claude on iPhone), the iOS keyboard's
// own dictation types into #dictArea; every pause hands the newly typed text to Claude.
let dictCommitted = 0;
let dictTimer = 0;

function enterDictation() {
  state.dictation = true;
  $("#dictBox").hidden = false;
  renderStatus();
}

function flushDictation() {
  clearTimeout(dictTimer);
  const v = $("#dictArea").value;
  if (v.length < dictCommitted) dictCommitted = v.length; // text was edited or deleted
  const fresh = v.slice(dictCommitted).trim();
  dictCommitted = v.length;
  if (fresh) commit(fresh);
}

// ---------- earphone speech ----------
function primeSpeech() {
  // iOS only lets speechSynthesis talk after a user gesture; warm it up on the Start tap
  if (settings.speak && "speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
  }
}
function speak(t) {
  if (!settings.speak || !("speechSynthesis" in window) || !t) return;
  const u = new SpeechSynthesisUtterance(t);
  u.lang = settings.lang === "en-US" ? "en-US" : "zh-CN";
  u.rate = 1.15;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ---------- rendering ----------
const KIND_CLASS = { 警惕: "warn", 机会: "good", 追问: "ask", 策略: "plan", 局势: "big" };

function renderCard(a) {
  const card = $("#card");
  if (!a) {
    card.className = "card empty";
    $("#kind").textContent = "";
    $("#advice").textContent = state.dictation
      ? "点下面的输入框，再点键盘上的 🎤 麦克风开始听写。有值得提醒的会显示在这里"
      : state.listening
        ? "正在听……有值得提醒的会显示在这里"
        : "先在「背景」里写下目标和底线，然后点「开始监听」。";
    $("#say").hidden = true;
    $("#ago").textContent = "";
    return;
  }
  card.className = "card " + (KIND_CLASS[a.kind] || "plan") + (a.streaming ? " streaming" : "");
  $("#kind").textContent = a.kind;
  $("#advice").textContent = a.text;
  $("#say").hidden = !a.say;
  $("#say").textContent = a.say ? `「${a.say}」` : "";
  card.dataset.at = a.at;
  renderAgo();
}

function renderAgo() {
  const at = Number($("#card").dataset.at || 0);
  $("#ago").textContent = at ? agoText(at) : "";
}
function agoText(at) {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 5 ? "刚刚" : s < 60 ? `${s} 秒前` : `${Math.floor(s / 60)} 分钟前`;
}

function renderHistory() {
  const ol = $("#history");
  ol.replaceChildren(
    ...state.advice.slice(1, 12).map((a) => {
      const li = document.createElement("li");
      li.className = KIND_CLASS[a.kind] || "plan";
      const k = document.createElement("b");
      k.textContent = a.kind;
      const t = document.createElement("span");
      t.textContent = a.text.split("\n")[0] + (a.say ? `  「${a.say}」` : "");
      const w = document.createElement("time");
      w.textContent = agoText(a.at);
      li.append(k, t, w);
      return li;
    }),
  );
}

function renderTranscript() {
  const box = $("#transcript");
  box.replaceChildren(
    ...state.transcript.slice(-60).map((e) => {
      const p = document.createElement("p");
      if (e.manual) p.className = "manual";
      p.textContent = e.text;
      return p;
    }),
  );
  $("#tcount").textContent = state.transcript.length ? `${state.transcript.length} 句` : "";
  $("#captions").classList.toggle("empty", !state.transcript.length);
  box.scrollTop = box.scrollHeight;
}

// the sentence still being spoken, shown greyed out under the captions
function renderPartial(t) {
  $("#partial").textContent = t || "";
  if (t) $("#transcript").scrollTop = $("#transcript").scrollHeight;
}

function renderLive(t) {
  $("#live").textContent = t ? "🎙 " + t : "";
}

function renderStatus() {
  if (state.dictation) {
    const active = document.activeElement === $("#dictArea");
    $("#dot").className = "dot" + (active ? " on" : "");
    $("#statusText").textContent = active ? "键盘听写中" : "键盘听写";
    $("#micBtn").textContent = "键盘听写";
    $("#micBtn").classList.remove("on");
    if (!state.advice.length) renderCard(null);
    return;
  }
  $("#dot").className = "dot" + (state.listening ? " on" : "");
  $("#statusText").textContent = state.listening ? "监听中" : state.transcript.length ? "已暂停" : "未开始";
  $("#micBtn").textContent = state.listening ? "暂停" : state.transcript.length ? "继续监听" : "开始监听";
  $("#micBtn").classList.toggle("on", state.listening);
  if (!state.advice.length) renderCard(null);
}

function setThinking(on, manual) {
  $("#card").classList.toggle("thinking", on);
  $("#askBtn").textContent = on && manual ? "思考中…" : "现在怎么办？";
}

function renderMeta() {
  if (usingAccount()) {
    $("#meta").textContent = `用你的 Claude 账号额度 · 已分析 ${state.usage.calls} 次`;
    return;
  }
  if (settings.provider === "zhipu") {
    const name = (ZHIPU_MODELS[settings.zhipuModel] || settings.zhipuModel).replace(/（.*）/, "");
    const asr = ASR[activeAsr()]?.name || "手机自带";
    $("#meta").textContent = `识别：${asr} · 分析：智谱 ${name} · ${state.usage.calls} 次`;
    return;
  }
  const m = MODELS[settings.model];
  $("#meta").textContent = `${m ? m.label.replace(/（.*）/, "") : settings.model} · 已分析 ${state.usage.calls} 次 · 约 $${state.usage.cost.toFixed(2)}`;
}

function applyBackendUI() {
  const account = usingAccount();
  const prov = $("#fProvider").value || settings.provider;
  document.querySelectorAll(".api-only").forEach((el) => {
    el.hidden =
      account ||
      (el.classList.contains("p-zhipu") && prov !== "zhipu") ||
      (el.classList.contains("p-anthropic") && prov !== "anthropic");
  });
  const asr = $("#fAsr").value || settings.asr;
  document.querySelectorAll(".asr-db").forEach((el) => (el.hidden = asr !== "doubao" && asr !== "doubao-stream"));
  document.querySelectorAll(".asr-sf").forEach((el) => (el.hidden = asr !== "siliconflow"));
  document.querySelectorAll(".asr-zhipu").forEach((el) => (el.hidden = asr !== "zhipu"));
  document.querySelectorAll(".asr-browser").forEach((el) => (el.hidden = asr !== "browser"));
  $("#accountNote").hidden = !account;
  renderMeta();
}

let noticeTimer = 0;
function showNotice(t) {
  const n = $("#notice");
  n.textContent = t;
  n.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (n.hidden = true), 7000);
}

setInterval(() => {
  $("#clock").textContent = state.listening && state.startedAt ? fmtTime(Date.now() - state.startedAt) : "";
  renderAgo();
}, 1000);

// ---------- sheets ----------
function openSheet(id) {
  document.querySelectorAll(".sheet").forEach((s) => (s.hidden = s.id !== id));
  if (id === "setSheet") {
    $("#fProvider").value = settings.provider;
    $("#fZKey").value = settings.zhipuKey;
    $("#fZModel").value = settings.zhipuModel;
    $("#fAsr").value = settings.asr;
    $("#fSfKey").value = settings.sfKey;
    $("#fSfModel").value = settings.sfModel;
    $("#fDbAppId").value = settings.dbAppId;
    $("#fDbToken").value = settings.dbToken;
    applyBackendUI();
    $("#fKey").value = settings.apiKey;
    $("#fBase").value = settings.baseURL;
    $("#fModel").value = settings.model;
    $("#fEffort").value = settings.effort;
    $("#fLang").value = settings.lang;
    $("#fMin").value = settings.minChars;
    $("#fSpeak").checked = settings.speak;
  } else if (id === "prepSheet") {
    $("#pMe").value = prep.me;
    $("#pGoal").value = prep.goal;
    $("#pThem").value = prep.them;
    $("#pNotes").value = prep.notes;
  }
}
function closeSheets() {
  document.querySelectorAll(".sheet").forEach((s) => (s.hidden = true));
}

function init() {
  const sel = $("#fModel");
  for (const [id, m] of Object.entries(MODELS)) sel.add(new Option(m.label, id));
  const zsel = $("#fZModel");
  for (const [id, label] of Object.entries(ZHIPU_MODELS)) zsel.add(new Option(label, id));
  $("#fProvider").onchange = applyBackendUI;
  $("#fAsr").onchange = applyBackendUI;

  $("#micBtn").onclick = () => (state.listening ? stopListening() : startListening());
  $("#askBtn").onclick = () => analyze(true);
  $("#prepBtn").onclick = () => openSheet("prepSheet");
  $("#setBtn").onclick = () => openSheet("setSheet");
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeSheets));

  const dict = $("#dictArea");
  dict.addEventListener("input", () => {
    clearTimeout(dictTimer);
    dictTimer = setTimeout(flushDictation, 1500);
  });
  dict.addEventListener("focus", renderStatus);
  dict.addEventListener("blur", () => {
    flushDictation();
    renderStatus();
  });
  $("#dictDone").onclick = () => dict.blur();

  $("#manualForm").onsubmit = (e) => {
    e.preventDefault();
    const v = $("#manualInput").value;
    $("#manualInput").value = "";
    commit(v, true);
  };

  $("#setForm").onsubmit = (e) => {
    e.preventDefault();
    settings.provider = $("#fProvider").value;
    settings.zhipuKey = $("#fZKey").value.trim();
    settings.zhipuModel = $("#fZModel").value;
    settings.asr = $("#fAsr").value;
    settings.sfKey = $("#fSfKey").value.trim();
    settings.sfModel = $("#fSfModel").value;
    settings.dbAppId = $("#fDbAppId").value.trim();
    settings.dbToken = $("#fDbToken").value.trim();
    asrFailed = false;
    settings.apiKey = $("#fKey").value.trim();
    settings.baseURL = $("#fBase").value.trim();
    settings.model = $("#fModel").value;
    settings.effort = $("#fEffort").value;
    settings.lang = $("#fLang").value;
    settings.minChars = Math.max(1, Number($("#fMin").value) || 12);
    settings.speak = $("#fSpeak").checked;
    LS.set("settings", settings);
    closeSheets();
    renderMeta();
    if (state.listening) restartRecognizer();
    showNotice("设置已保存");
  };

  $("#prepForm").onsubmit = (e) => {
    e.preventDefault();
    prep.me = $("#pMe").value.trim();
    prep.goal = $("#pGoal").value.trim();
    prep.them = $("#pThem").value.trim();
    prep.notes = $("#pNotes").value.trim();
    LS.set("prep", prep);
    closeSheets();
    showNotice("背景已保存");
  };

  $("#copyBtn").onclick = async () => {
    const t0 = state.transcript[0]?.at ?? Date.now();
    const text = [
      "【对话转写】",
      ...state.transcript.map((e) => `[${fmtTime(e.at - t0)}] ${e.text}`),
      "",
      "【AI 提醒】",
      ...state.advice
        .slice()
        .reverse()
        .map((a) => `[${fmtTime(a.at - t0)}] 【${a.kind}】${a.text}${a.say ? `  说：「${a.say}」` : ""}`),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      showNotice("已复制，可以粘贴给 Claude 做复盘");
    } catch {
      showNotice("复制失败");
    }
  };

  $("#resetBtn").onclick = () => {
    if (!confirm("清空本场的转写和提醒？（背景和设置会保留）")) return;
    stopListening();
    state.transcript = [];
    state.advice = [];
    state.analyzedCount = 0;
    state.startedAt = 0;
    state.usage = { calls: 0, cost: 0 };
    ["transcript", "advice", "usage"].forEach((k) => LS.set(k, k === "usage" ? state.usage : []));
    renderTranscript();
    renderHistory();
    renderCard(null);
    renderMeta();
    renderStatus();
    closeSheets();
  };

  renderTranscript();
  renderHistory();
  renderCard(state.advice[0] || null);
  renderStatus();
  renderMeta();
  sampleReady.then(() => {
    applyBackendUI();
    if (!usingAccount() && !hasKey()) openSheet("setSheet");
  });
}

init();
