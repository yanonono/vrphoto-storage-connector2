import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  apiVersion,
  connectorConfigKey,
  generateConnectorConfig,
  normalizeOptionalEnv,
  readConnectorConfig,
  setupConnectorPayload,
} from './config';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();
const setupTokenStateKey = '.vrphoto/setup-token.json';
const setupTokenUrlKey = '.vrphoto/setup-token-url.txt';
const setupTokenTtlMs = 60 * 60 * 1000;

type SetupTokenState = {
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  setupUrl: string;
};

// Setup WorkerもStorage Connectorと同じヘッダー方針でレスポンスを整える。
app.use('*', async (c, next) => {
  await next();
  c.res = withSetupHeaders(c.res, c.env, c.req.raw);
});

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return jsonError(error.status, error.message, c.env, c.req.raw);
  }

  console.error('setup_worker_error', { message: error instanceof Error ? error.message : 'unknown_error' });
  return jsonError(500, 'internal_server_error', c.env, c.req.raw);
});

app.options('*', (c) => {
  return withSetupHeaders(new Response(null, { status: 204 }), c.env, c.req.raw);
});

app.get('/health', (c) => {
  return c.json({
    ok: true,
    service: 'vrphoto-storage-connector-setup',
    apiVersion,
    connectorUrl: normalizeOptionalEnv(c.env.CONNECTOR_URL) || null,
  });
});

app.post('/setup-token', async (c) => {
  const existingConfig = await readConnectorConfig(c.env);
  if (existingConfig) {
    return jsonError(409, 'setup_already_completed', c.env, c.req.raw);
  }

  const activeState = await readActiveSetupTokenState(c.env);
  if (activeState) {
    // 有効なtokenが既にある場合は再発行せず、R2内の案内ファイルだけを参照させる。
    return c.json({ created: false, tokenFileKey: setupTokenUrlKey, expiresAt: activeState.expiresAt });
  }

  const token = generateSetupToken();
  const setupUrl = setupUrlWithToken(c.req.raw, token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + setupTokenTtlMs);
  const state: SetupTokenState = {
    tokenHash: await sha256Hex(token),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    setupUrl,
  };

  await c.env.PHOTOS.put(setupTokenStateKey, JSON.stringify(state), {
    httpMetadata: { contentType: 'application/json' },
  });
  await c.env.PHOTOS.put(setupTokenUrlKey, setupTokenFileBody(state), {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });

  return c.json({ created: true, tokenFileKey: setupTokenUrlKey, expiresAt: state.expiresAt }, 201);
});

app.get('/setup', completeSetup);
app.post('/setup', completeSetup);

async function completeSetup(c: Context<{ Bindings: Env }>): Promise<Response> {
  const existingConfig = await readConnectorConfig(c.env);
  const connectorUrl = normalizeOptionalEnv(c.env.CONNECTOR_URL);
  if (existingConfig) {
    // 初期化済みなら/setup自体を処理せず、設定情報も返さない。
    return jsonError(409, 'setup_already_completed', c.env, c.req.raw);
  }

  await verifySetupToken(c.env, c.req.raw);

  const generated = await generateConnectorConfig();
  // Storage Connectorが同じR2 bucketから読めるように、公開鍵とIDだけを保存する。
  await c.env.PHOTOS.put(connectorConfigKey, JSON.stringify(generated.storedConfig), {
    httpMetadata: { contentType: 'application/json' },
  });
  await c.env.PHOTOS.delete(setupTokenStateKey);
  await c.env.PHOTOS.delete(setupTokenUrlKey);

  return c.json(
    {
      initialized: true,
      connector: {
        ...setupConnectorPayload(c.req.raw, generated.storedConfig, connectorUrl),
        privateKeyJwk: generated.privateKeyJwk,
      },
    },
    201
  );
}

async function readActiveSetupTokenState(env: Env): Promise<SetupTokenState | null> {
  const state = await readSetupTokenState(env);
  if (!state) {
    return null;
  }

  return Date.now() <= Date.parse(state.expiresAt) ? state : null;
}

async function readSetupTokenState(env: Env): Promise<SetupTokenState | null> {
  const object = await env.PHOTOS.get(setupTokenStateKey);
  if (!object) {
    return null;
  }

  try {
    return JSON.parse(await object.text()) as SetupTokenState;
  } catch {
    throw new HTTPException(500, { message: 'setup_token_state_invalid' });
  }
}

async function verifySetupToken(env: Env, request: Request): Promise<void> {
  const state = await readSetupTokenState(env);
  if (!state) {
    throw new HTTPException(403, { message: 'setup_token_required' });
  }

  if (Date.now() > Date.parse(state.expiresAt)) {
    throw new HTTPException(410, { message: 'setup_token_expired' });
  }

  const token = new URL(request.url).searchParams.get('setupToken');
  if (!token || (await sha256Hex(token)) !== state.tokenHash) {
    throw new HTTPException(403, { message: 'setup_token_invalid' });
  }
}

function generateSetupToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlBytes(bytes);
}

function setupUrlWithToken(request: Request, token: string): string {
  const url = new URL('/setup', request.url);
  url.searchParams.set('setupToken', token);
  return url.toString();
}

function setupTokenFileBody(state: SetupTokenState): string {
  return [
    'VRPhoto Storage Connector setup URL',
    '',
    'Cloudflare R2 bucket の内容を確認できる人だけが、このURLを開いて初期セットアップを完了できます。',
    'このURLは60分で期限切れになります。',
    '',
    state.setupUrl,
    '',
    `expiresAt: ${state.expiresAt}`,
  ].join('\n');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function withSetupHeaders(response: Response, env: Env, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');

  const origin = request.headers.get('origin');
  if (origin && origin === env.ALLOWED_ORIGIN) {
    // setupは初期化用途に限定し、Storage ConnectorのR2操作メソッドは許可しない。
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
    headers.set('access-control-allow-headers', 'content-type');
    headers.set('access-control-max-age', '600');
    headers.append('vary', 'origin');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonError(status: number, error: string, env: Env, request: Request): Response {
  return withSetupHeaders(Response.json({ error }, { status }), env, request);
}

export default app;
