// Turns docs/index.html into the Artifact page (the Artifact host supplies <html>/<head>/<body>).
import fs from "node:fs";

const src = fs.readFileSync("docs/index.html", "utf8");
const pick = (re) => (src.match(re) || [])[0] || "";
const title = pick(/<title>[\s\S]*?<\/title>/);
const fonts = src.match(/<link rel="stylesheet"[^>]*>/g)?.join("\n") || "";
const style = pick(/<style>[\s\S]*?<\/style>/);
const body = src.match(/<body>([\s\S]*)<\/body>/)[1];

fs.mkdirSync("artifact", { recursive: true });
fs.writeFileSync("artifact/tanpan.html", [title, fonts, style, body.trim()].join("\n") + "\n");
console.log("wrote artifact/tanpan.html");
