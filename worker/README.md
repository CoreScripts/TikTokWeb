# TikTok Cloudflare Worker

This is an experimental edge version of the TikTok gateway. It serves the
existing page from the `public/` asset binding and proxies TikTok HTTP, media,
cookies, and WebSocket requests from Cloudflare instead of Render.

## Local development

From the repository root:

```sh
npm install --prefix worker
npm run dev --prefix worker
```

Wrangler needs a Cloudflare account for the asset binding. The existing Render
server remains the fallback while this version is tested.

## Deploy

```sh
npm run deploy --prefix worker
```

Attach a custom hostname to the Worker in Cloudflare, then open that hostname.
Do not put the Worker in front of Render if the goal is to reduce Render
bandwidth; the Worker must fetch TikTok directly.

This first port is intentionally separate from the Node gateway. Verify the
feed, navigation, media playback, login/cookies, and WebSockets before making
it the primary deployment. TikTok changes its response formats and signed URLs
frequently, so a working Render fallback is recommended.
