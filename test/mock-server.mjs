// Local test server: serves ../docs and fakes POST /v1/messages as an SSE stream.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
let last = null;
let n = 0;

const sse = (res, ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

http
  .createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "*");
    if (req.method === "OPTIONS") return res.end();

    if (req.url === "/last-request") {
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify(last, null, 2));
    }

    if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const json = JSON.parse(body);
        last = { url: req.url, headers: req.headers, body: json };
        const manual = JSON.stringify(json.system).includes("现在怎么办");
        n++;
        const text = manual
          ? "【局势】对方在用截止期限施压\n- 先确认交期是否真的卡死\n- 用数量换单价\n说：「如果我们加到 600 台，单价能到多少？」"
          : n % 2 === 1
            ? "【警惕】对方用“今天必须定”施压\n说：「这个价格我需要和团队确认一下。」"
            : "PASS";
        res.writeHead(200, { "content-type": "text/event-stream" });
        sse(res, "message_start", { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, usage: { input_tokens: 900, output_tokens: 0 } } });
        sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        for (const chunk of text.match(/[\s\S]{1,6}/g)) {
          sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } });
          await new Promise((r) => setTimeout(r, 60));
        }
        sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
        sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 60 } });
        sse(res, "message_stop", { type: "message_stop" });
        res.end();
      });
      return;
    }

    const file = path.join(root, decodeURIComponent(req.url.split("?")[0]) === "/" ? "index.html" : req.url.split("?")[0]);
    if (!file.startsWith(root) || !fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end("not found");
    }
    const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" }[path.extname(file)] || "application/octet-stream";
    res.setHeader("content-type", type);
    fs.createReadStream(file).pipe(res);
  })
  .listen(8787, () => console.log("mock on http://localhost:8787"));
