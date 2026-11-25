const BASE = "/relay";
const GATE = `${BASE}/tt`;
const WS_GATE = `${BASE}/tt-ws`;
const CLIENT_JS = `${BASE}/tt-client.js`;
const DEFAULT_HOST = "www.tiktok.com";
const COOKIE_PREFIX = "aetheris_tt_";
const ALLOWED_DOMAINS = [
  "tiktok.com",
  "tiktokv.com",
  "tiktokv.eu",
  "tiktokcdn.com",
  "tiktokcdn-eu.com",
  "tiktokcdn-us.com",
  "tiktokw.eu",
  "ttwstatic.com",
];

function allowedHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return ALLOWED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function gatewayUrl(request, target, referer = target) {
  const base = new URL(request.url).origin;
  return `${base}${GATE}?url=${encodeURIComponent(target)}&referer=${encodeURIComponent(referer)}&tt=1`;
}

function safeTarget(raw, fallbackPath = "/") {
  let target;
  try {
    target = new URL(raw || `https://${DEFAULT_HOST}${fallbackPath}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(target.protocol) || !allowedHost(target.hostname)) return null;
  return target;
}

function upstreamCookies(request) {
  const source = request.headers.get("cookie") || "";
  return source
    .split(/;\s*/)
    .filter((part) => part.startsWith(COOKIE_PREFIX))
    .map((part) => part.slice(COOKIE_PREFIX.length))
    .filter(Boolean)
    .join("; ");
}

function upstreamHeaders(request, target, referer) {
  const headers = new Headers();
  for (const name of ["accept", "content-type", "range", "user-agent", "x-requested-with"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const cookies = upstreamCookies(request);
  if (cookies) headers.set("cookie", cookies);
  headers.set("referer", referer || target.href);
  headers.set("origin", target.origin);
  return headers;
}

function rewriteSetCookies(headers) {
  const values = headers.getSetCookie ? headers.getSetCookie() : [];
  if (!values.length) {
    const combined = headers.get("set-cookie");
    return combined ? [combined] : [];
  }
  return values;
}

function browserCookies(responseHeaders) {
  return rewriteSetCookies(responseHeaders).map((value) => {
    const parts = value.split(";");
    const nameValue = parts.shift() || "";
    return [
      `${COOKIE_PREFIX}${nameValue}`,
      ...parts.filter((part) => !/^\s*domain=/i.test(part) && !/^\s*path=/i.test(part)),
      " Path=/",
    ].join(";");
  });
}

function rewriteText(text, request, referer) {
  const absolute = /https?:\/\/[A-Za-z0-9._~-]+\.(?:tiktok\.com|tiktokv\.com|tiktokv\.eu|tiktokcdn\.com|tiktokcdn-eu\.com|tiktokcdn-us\.com|tiktokw\.eu|ttwstatic\.com)(?::\d+)?\/[^\s"'<>\\`]*/gi;
  const protocolRelative = /(^|["'(\s=])\/\/(?:[A-Za-z0-9._~-]+\.)?(?:tiktok\.com|tiktokv\.com|tiktokv\.eu|tiktokcdn\.com|tiktokcdn-eu\.com|tiktokcdn-us\.com|tiktokw\.eu|ttwstatic\.com)(?::\d+)?\/[^\s"'<>\\`)]+/gi;
  const replace = (value) => gatewayUrl(request, value, referer);
  return text
    .replace(absolute, replace)
    .replace(protocolRelative, (match, prefix) => {
      const raw = match.slice(prefix.length);
      return prefix + replace(`https:${raw}`);
    });
}

function responseHeaders(upstream, request, target) {
  const headers = new Headers();
  for (const name of [
    "accept-ranges",
    "cache-control",
    "content-disposition",
    "content-encoding",
    "content-language",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
    "location",
    "vary",
  ]) {
    const value = upstream.headers.get(name);
    if (!value) continue;
    headers.set(name, name === "location" ? gatewayUrl(request, new URL(value, target).href, target.href) : value);
  }
  for (const cookie of browserCookies(upstream.headers)) headers.append("set-cookie", cookie);
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

async function proxyHttp(request, target, referer) {
  const method = request.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  const upstream = await fetch(target, {
    method,
    headers: upstreamHeaders(request, target, referer),
    body,
    redirect: "manual",
  });
  const headers = responseHeaders(upstream, request, target);
  const contentType = upstream.headers.get("content-type") || "";
  if (contentType.includes("text/") || contentType.includes("javascript") || contentType.includes("json")) {
    let text = await upstream.text();
    if (contentType.includes("text/html")) {
      text = text.replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}<script src="${CLIENT_JS}"></script>`);
    }
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(rewriteText(text, request, referer || target.href), {
      status: upstream.status,
      headers,
    });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function proxyWebSocket(request, target) {
  const upstreamUrl = new URL(target);
  upstreamUrl.protocol = upstreamUrl.protocol === "wss:" ? "https:" : "http:";
  const response = await fetch(upstreamUrl, {
    headers: new Headers({
      Upgrade: "websocket",
      Cookie: upstreamCookies(request),
      Origin: target.origin,
      Referer: target.href,
    }),
  });
  if (!response.webSocket) return new Response("TikTok WebSocket unavailable", { status: 502 });

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  const upstream = response.webSocket;
  server.accept({ allowHalfOpen: true });
  upstream.accept({ allowHalfOpen: true });
  server.addEventListener("message", (event) => upstream.send(event.data));
  upstream.addEventListener("message", (event) => server.send(event.data));
  server.addEventListener("close", () => upstream.close());
  upstream.addEventListener("close", () => server.close());
  server.addEventListener("error", () => upstream.close());
  upstream.addEventListener("error", () => server.close());
  return new Response(null, { status: 101, webSocket: client });
}

async function localAsset(request, env, pathname) {
  if (!env.ASSETS) return new Response("Assets binding is missing", { status: 500 });
  const assetPath = pathname === "/" ? "/tiktok.html" : pathname;
  const response = await env.ASSETS.fetch(new Request(new URL(assetPath, request.url), request));
  if (assetPath !== "/tiktok.html") return response;
  let html = await response.text();
  html = html
    .replace(/\s*<script src="\.\/js\/site\.js\?[^>]+><\/script>/i, "")
    .replace(/\s*<script defer src="\.\/js\/preload\.js\?[^>]+><\/script>/i, "")
    .replace(/\s*<script src="\/tiktok-config\.js"><\/script>/i, "<script>window.TIKTOK_RELAY_ORIGIN = '';</script>")
    .replace(/\s*<link\s+rel="shortcut icon"\s+href="\.\/assets\/images\/tiktok\.webp"\s+type="image\/webp"\s*\/>/i, "")
    .replaceAll("./assets/images/tiktok.webp", "./assets/images/icon.webp")
    .replaceAll("/tiktok/tt?url=", `${GATE}?url=`);
  return new Response(html, {
    status: response.status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (url.pathname === "/tiktok-config.js") {
      return new Response("window.TIKTOK_RELAY_ORIGIN = '';\n", {
        headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/" || url.pathname === "/tiktok.html" || url.pathname.startsWith("/js/") || url.pathname.startsWith("/assets/")) {
      return localAsset(request, env, url.pathname);
    }
    if (url.pathname === CLIENT_JS) {
      const response = await localAsset(request, env, "/js/tiktok-client.js");
      const source = await response.text();
      return new Response(source.replaceAll('"/tiktok', '"/relay').replaceAll("'/tiktok", "'/relay"), {
        status: response.status,
        headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === WS_GATE) {
      let target;
      try {
        target = new URL(url.searchParams.get("url") || "");
      } catch {
        return new Response("Invalid WebSocket URL", { status: 400 });
      }
      if (!/^wss?:$/.test(target.protocol) || !allowedHost(target.hostname)) return new Response("Target not allowed", { status: 403 });
      return proxyWebSocket(request, target);
    }

    const upstreamPath = url.pathname.startsWith(BASE)
      ? url.pathname.slice(BASE.length) || "/"
      : url.pathname;
    const target = safeTarget(url.pathname === GATE ? url.searchParams.get("url") : "", url.pathname === GATE ? "/" : upstreamPath);
    if (!target) return new Response("TikTok target not allowed", { status: 403 });
    const referer = url.searchParams.get("referer") || target.href;
    return proxyHttp(request, target, referer);
  },
};
