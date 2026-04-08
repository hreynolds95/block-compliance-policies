/**
 * Quincy Proxy — Cloudflare Worker
 *
 * Forwards requests from the GitHub Pages UI to the Anthropic API,
 * injecting the API key from an environment secret so it never
 * touches the browser.
 *
 * Required secret (set in Worker Settings → Variables → Secrets):
 *   ANTHROPIC_API_KEY  →  your sk-ant-... key
 *
 * Deployment (web dashboard):
 *   1. dash.cloudflare.com → Workers & Pages → Create → "Hello World" Worker
 *   2. Replace the default code with this file
 *   3. Deploy, then go to Settings → Variables → add secret ANTHROPIC_API_KEY
 *
 * Deployment (wrangler CLI, if Node.js is available):
 *   npx wrangler deploy proxy/worker.js --name quincy-proxy --compatibility-date 2024-01-01
 *   npx wrangler secret put ANTHROPIC_API_KEY
 */

const ALLOWED_ORIGIN  = 'https://hreynolds95.github.io';
const ANTHROPIC_URL   = 'https://api.anthropic.com/v1/messages';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age':       '86400',
};

export default {
  async fetch(request, env) {
    // ── CORS preflight ───────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Origin check ─────────────────────────────────────────────────────────
    const origin = request.headers.get('Origin') || '';
    if (origin !== ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403 });
    }

    // ── Only accept POST /v1/messages ─────────────────────────────────────────
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/messages') {
      return new Response('Not found', { status: 404 });
    }

    // ── Forward to Anthropic ──────────────────────────────────────────────────
    const body = await request.text();

    const upstream = await fetch(ANTHROPIC_URL, {
      method:  'POST',
      headers: {
        'content-type':      'application/json',
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'prompt-caching-2024-07-31',
      },
      body,
    });

    // ── Stream the response straight back ─────────────────────────────────────
    const responseHeaders = {
      ...CORS_HEADERS,
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    };

    return new Response(upstream.body, {
      status:  upstream.status,
      headers: responseHeaders,
    });
  },
};
