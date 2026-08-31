import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { apiVersion, normalizeOptionalEnv, readConnectorConfig, requireConnectorConfig } from './config';
import { TokenError, verifyAccessToken } from './token';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

// すべてのレスポンスに共通ヘッダーを付け、CORSや最低限の保護を一箇所で管理する。
app.use('*', async (c, next) => {
  await next();
  c.res = withSecurityHeaders(c.res, c.env, c.req.raw);
});

// HonoのHTTPExceptionとトークン検証エラーは、呼び出し側が判定しやすいJSONで返す。
app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return withSecurityHeaders(error.getResponse(), c.env, c.req.raw);
  }

  if (error instanceof TokenError) {
    return jsonError(error.message === 'token_required' ? 401 : 403, error.message, c.env, c.req.raw);
  }

  console.error('connector_error', { message: error instanceof Error ? error.message : 'unknown_error' });
  return jsonError(500, 'internal_server_error', c.env, c.req.raw);
});

app.options('*', (c) => {
  return withSecurityHeaders(new Response(null, { status: 204 }), c.env, c.req.raw);
});

app.get('/health', async (c) => {
  const config = await readConnectorConfig(c.env);

  // setupRequiredにより、Storage Connectorだけを先にデプロイした状態を検出できる。
  return c.json({
    ok: true,
    service: 'vrphoto-storage-connector',
    apiVersion,
    connectorId: config?.connectorId ?? null,
    setupRequired: !config,
    storage: 'r2',
  });
});

app.post('/pair', async (c) => {
  const config = await requireConnectorConfig(c.env);
  await verifyAccessToken(config, readToken(c.req.raw), { operation: 'pair' });
  const connectorUrl = new URL(c.req.url).origin;
  const payload = {
    connectorId: config.connectorId,
    connectorUrl,
    apiVersion,
  };

  const sitePairingEndpoint = normalizeOptionalEnv(c.env.SITE_PAIRING_ENDPOINT);
  if (!sitePairingEndpoint) {
    // コールバック方式が未設定の環境では、管理サイトへ手動登録できる情報を返す。
    return c.json({ paired: false, mode: 'manual', connector: payload });
  }

  const response = await fetch(sitePairingEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new HTTPException(502, { message: 'pairing_callback_failed' });
  }

  return c.json({ paired: true, connector: payload });
});

app.get('/v1/objects', async (c) => {
  const prefix = c.req.query('prefix') ?? '';
  const config = await requireConnectorConfig(c.env);
  // 一覧取得はprefix単位で署名し、意図しないbucket全体列挙を防ぐ。
  await verifyAccessToken(config, readToken(c.req.raw), { operation: 'list', prefix });
  const listed = await c.env.PHOTOS.list({ prefix, cursor: c.req.query('cursor'), limit: 1000 });

  return c.json({
    objects: listed.objects.map((object) => ({
      key: object.key,
      size: object.size,
      etag: object.httpEtag,
      uploaded: object.uploaded.toISOString(),
    })),
    truncated: listed.truncated,
    cursor: listed.truncated ? listed.cursor : null,
  });
});

app.put('/v1/objects/*', async (c) => {
  const key = readObjectKey(c.req.raw);
  const config = await requireConnectorConfig(c.env);
  // URL上のkeyと署名payloadのkeyを照合して、署名済みURLの流用を防ぐ。
  const payload = await verifyAccessToken(config, readToken(c.req.raw), { operation: 'write', key });
  const contentType = c.req.header('content-type') ?? '';
  const contentLength = Number(c.req.header('content-length') ?? '0');

  if (!c.req.raw.body) {
    throw new HTTPException(400, { message: 'request_body_required' });
  }

  if (payload.contentType && payload.contentType !== contentType) {
    // 署名時に固定したMIME type以外のアップロードは拒否する。
    throw new HTTPException(415, { message: 'content_type_not_allowed' });
  }

  if (payload.maxBytes !== undefined && (!Number.isFinite(contentLength) || contentLength > payload.maxBytes)) {
    // bodyを読み込む前にContent-Lengthで上限を確認し、Workerメモリを守る。
    throw new HTTPException(413, { message: 'content_length_too_large' });
  }

  // request.bodyをそのままR2へ渡し、画像全体をWorkerメモリへ載せない。
  const object = await c.env.PHOTOS.put(key, c.req.raw.body, {
    httpMetadata: {
      contentType,
    },
    customMetadata: {
      photoId: payload.photoId ?? '',
      userId: payload.userId ?? '',
      connectorId: config.connectorId,
    },
  });

  return c.json({ key, size: object?.size ?? contentLength, etag: object?.httpEtag ?? null }, 201);
});

app.on('HEAD', '/v1/objects/*', async (c) => {
  const key = readObjectKey(c.req.raw);
  const config = await requireConnectorConfig(c.env);
  await verifyAccessToken(config, readToken(c.req.raw), { operation: 'head', key });
  const object = await c.env.PHOTOS.head(key);

  if (!object) {
    throw new HTTPException(404, { message: 'object_not_found' });
  }

  return new Response(null, { headers: objectResponseHeaders(object) });
});

app.get('/v1/objects/*', async (c) => {
  const key = readObjectKey(c.req.raw);
  const config = await requireConnectorConfig(c.env);
  // 実行環境によってHEADがGETハンドラへ届く場合に備え、同じ検証をここでも行う。
  if (c.req.method === 'HEAD') {
    await verifyAccessToken(config, readToken(c.req.raw), { operation: 'head', key });
    const headObject = await c.env.PHOTOS.head(key);
    if (!headObject) {
      throw new HTTPException(404, { message: 'object_not_found' });
    }

    return new Response(null, { headers: objectResponseHeaders(headObject) });
  }

  await verifyAccessToken(config, readToken(c.req.raw), { operation: 'read', key });
  // 条件付き取得とRangeはR2に直接渡して、キャッシュ確認や部分取得をR2側で処理する。
  const object = await c.env.PHOTOS.get(key, {
    onlyIf: c.req.raw.headers,
    range: c.req.raw.headers,
  });

  if (!object) {
    throw new HTTPException(404, { message: 'object_not_found' });
  }

  const headers = objectResponseHeaders(object);
  if (!('body' in object)) {
    // R2が条件付き取得で本文なしを返した場合は304としてそのまま上位へ返す。
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, {
    status: c.req.header('range') ? 206 : 200,
    headers,
  });
});

app.delete('/v1/objects/*', async (c) => {
  const key = readObjectKey(c.req.raw);
  const config = await requireConnectorConfig(c.env);
  await verifyAccessToken(config, readToken(c.req.raw), { operation: 'delete', key });
  await c.env.PHOTOS.delete(key);

  return c.json({ deleted: true, key });
});

function readToken(request: Request): string | null {
  // ブラウザ表示用URLではquery、API呼び出しではAuthorization headerを使えるようにする。
  const token = new URL(request.url).searchParams.get('token');
  if (token) {
    return token;
  }

  const authorization = request.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
}

function readObjectKey(request: Request): string {
  const pathname = new URL(request.url).pathname;
  const encodedKey = pathname.startsWith('/v1/objects/') ? pathname.slice('/v1/objects/'.length) : '';
  if (!encodedKey) {
    throw new HTTPException(400, { message: 'object_key_invalid' });
  }

  const key = decodeURIComponent(encodedKey);
  const isVrphotoObjectKey = /^VRPotos\/[A-Za-z0-9_-]+\/[0-9A-Zabcdefghijklmnopq]+\.[0-9]+\.[A-Za-z0-9]+$/.test(key);
  if (!isVrphotoObjectKey) {
    // 管理サイトが予約したVRPhoto写真オブジェクト以外へアクセスさせない。
    throw new HTTPException(400, { message: 'object_key_invalid' });
  }

  return key;
}

function objectResponseHeaders(object: R2Object): Headers {
  const headers = new Headers();
  // R2に保存されたHTTP Metadataを復元し、表示側のContent-TypeやETagを維持する。
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('content-length', String(object.size));
  headers.set('cache-control', object.httpMetadata?.cacheControl ?? 'private, max-age=300');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  return headers;
}

function withSecurityHeaders(response: Response, env: Env, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');

  const origin = request.headers.get('origin');
  if (origin && origin === env.ALLOWED_ORIGIN) {
    // 管理サイトのOriginだけを許可し、公開bucket風の横断アクセスを避ける。
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-methods', 'GET,HEAD,PUT,DELETE,POST,OPTIONS');
    headers.set('access-control-allow-headers', 'authorization,content-type,content-length,if-none-match,if-match,range');
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
  return withSecurityHeaders(Response.json({ error }, { status }), env, request);
}

export default app;
