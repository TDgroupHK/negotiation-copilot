import Anthropic from "@anthropic-ai/sdk";

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
  { apiKey: "", baseURL: "", model: "claude-opus-5", effort: "low", lang: "zh-CN", minChars: 12, speak: false },
  LS.get("settings", {}),
);
const prep = Object.assign({ me: "", goal: "", them: "", notes: "" }, LS.get("prep", {}));

const state = {
  listening: false,
  startedAt: 0,
  transcript: LS.get("transcript", []), // {at, text, manual?}
  advice: LS.get("advice", []), // {at, kind, text, say, manual?}
  analyzedCount: 0, // transcript entries already analyzed
  inFlight: null,
  pending: false,
  usage: LS.get("usage", { calls: 0, cost: 0 }),
};
state.analyzedCount = state.transcript.length;

const $ = (s) => document.querySelector(s);

// ---------- Claude ----------
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
- 如果最新内容没有值得提醒的（寒暄、闲聊、信息量低，或者和你之前的提醒重复），只输出：PASS
- 否则输出 1~2 行，不要写其他任何内容：
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
  if (olderText.length > 3500) olderText = "…" + olderText.slice(-3500);

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

async function analyze(manual = false) {
  if (!settings.apiKey && !settings.baseURL.trim()) {
    showNotice("请先在「设置」里填写 Claude API Key");
    openSheet("setSheet");
    return;
  }
  if (!manual && state.transcript.length === state.analyzedCount) return;

  if (state.inFlight) {
    if (!manual) {
      state.pending = true;
      return;
    }
    state.inFlight.abort();
  }

  const ctl = new AbortController();
  state.inFlight = ctl;
  const upTo = state.transcript.length;
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

  setThinking(true, manual);
  let text = "";
  try {
    const stream = client().beta.messages.stream(params, { signal: ctl.signal });
    stream.on("text", (delta) => {
      text += delta;
      // don't flash anything while the reply might still turn out to be "PASS"
      if (!manual && "PASS".startsWith(text.trim().slice(0, 4).toUpperCase())) return;
      const a = parseAdvice(text, manual);
      if (a) renderCard({ ...a, at: Date.now(), manual, streaming: true });
    });
    const msg = await stream.finalMessage();
    state.analyzedCount = Math.max(state.analyzedCount, upTo);

    const u = msg.usage || {};
    state.usage.calls += 1;
    state.usage.cost +=
      ((u.input_tokens || 0) * m.inPrice + (u.output_tokens || 0) * m.outPrice) / 1e6;
    LS.set("usage", state.usage);

    if (msg.stop_reason === "refusal") {
      if (manual) showNotice("Claude 这次拒绝了回答，换个说法再试");
      renderCard(state.advice[0] || null);
    } else {
      const a = parseAdvice(text, manual);
      if (a) {
        const item = { ...a, at: Date.now(), manual };
        state.advice.unshift(item);
        state.advice = state.advice.slice(0, 50);
        LS.set("advice", state.advice);
        renderCard(item);
        renderHistory();
        speak(a.say ? `${a.text}。可以说：${a.say}` : a.text);
      } else {
        renderCard(state.advice[0] || null);
      }
    }
  } catch (err) {
    if (ctl.signal.aborted) return;
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

// ---------- speech recognition ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let silenceTimer = 0;
let interim = "";

function commit(text, manual = false) {
  text = text.trim();
  if (!text) return;
  state.transcript.push({ at: Date.now(), text, manual });
  LS.set("transcript", state.transcript.slice(-400));
  renderTranscript();
  scheduleAnalyze(manual ? 0 : 700);
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
    renderLive(interim);
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
      showNotice("没有麦克风权限：请在 iPhone 设置 → Safari → 麦克风 中允许，然后刷新页面");
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
    restartRecognizer();
  }
});

function startListening() {
  if (!SR) {
    showNotice("这个浏览器不支持语音识别。iPhone 请直接用 Safari 打开（不要从主屏幕图标或微信里打开），也可以先用下方手动补充");
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
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  renderLive("");
  renderStatus();
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
    $("#advice").textContent = state.listening ? "正在听……有值得提醒的会显示在这里" : "先在「背景」里写下目标和底线，然后点「开始监听」。";
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
  $("#tcount").textContent = state.transcript.length ? `（${state.transcript.length} 句）` : "";
  const last = state.transcript[state.transcript.length - 1];
  if (!interim) renderLive(last ? last.text : "");
}

function renderLive(t) {
  $("#live").textContent = t ? "🎙 " + t : "";
}

function renderStatus() {
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
  const m = MODELS[settings.model];
  $("#meta").textContent = `${m ? m.label.replace(/（.*）/, "") : settings.model} · 已分析 ${state.usage.calls} 次 · 约 $${state.usage.cost.toFixed(2)}`;
}

let noticeTimer = 0;
function showNotice(t) {
  const n = $("#notice");
  n.textContent = t;
  n.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (n.hidden = true), 6000);
}

setInterval(() => {
  $("#clock").textContent = state.listening && state.startedAt ? fmtTime(Date.now() - state.startedAt) : "";
  renderAgo();
}, 1000);

// ---------- sheets ----------
function openSheet(id) {
  document.querySelectorAll(".sheet").forEach((s) => (s.hidden = s.id !== id));
  if (id === "setSheet") {
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

  $("#micBtn").onclick = () => (state.listening ? stopListening() : startListening());
  $("#askBtn").onclick = () => analyze(true);
  $("#prepBtn").onclick = () => openSheet("prepSheet");
  $("#setBtn").onclick = () => openSheet("setSheet");
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeSheets));

  $("#manualForm").onsubmit = (e) => {
    e.preventDefault();
    const v = $("#manualInput").value;
    $("#manualInput").value = "";
    commit(v, true);
  };

  $("#setForm").onsubmit = (e) => {
    e.preventDefault();
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
  if (!settings.apiKey && !settings.baseURL) openSheet("setSheet");
}

init();
