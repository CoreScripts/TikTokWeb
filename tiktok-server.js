import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { handleTikTokRequest, upgradeTikTok } from "./lib/tiktok-gateway.js";

const root = fileURLToPath(new URL("./public/", import.meta.url));
const port = Number(process.env.PORT || 3000);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".webp": "image/webp",
};

async function serveLocal(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  const pathname = new URL(req.url, "http://localhost").pathname;
  const relative = pathname === "/" ? "tiktok.html" : pathname.slice(1);
  const file = normalize(join(root, relative));
  if (!file.startsWith(root)) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  if (!handleTikTokRequest(req, res)) serveLocal(req, res).catch(() => res.destroy());
});

server.on("upgrade", (req, socket, head) => {
  if (!upgradeTikTok(req, socket, head)) socket.destroy();
});

server.listen(port, () => {
  console.log(`TikTok server listening on port ${port}`);
});
