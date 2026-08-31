import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import app from '../src/index';
import setupApp from '../src/setup';
import type { AccessTokenPayload, Env, TokenOperation } from '../src/types';

const testEnv = env as unknown as Env;
const generatedConfigKey = '.vrphoto/connector-config.json';
const setupTokenStateKey = '.vrphoto/setup-token.json';
const setupTokenUrlKey = '.vrphoto/setup-token-url.txt';

const privateKeyJwk = {
  key_ops: ['sign'],
  ext: true,
  crv: 'Ed25519',
  d: 'JPY0WV71Q7XV98JB1391nqpWGHtXT_RtQVtieUdz_f8',
  x: '4BOz5zs9V_iL-k-JOjEmr7TvYJHYFXyWC-g67YXn2bQ',
  kty: 'OKP',
};

describe('VRPhoto Storage Connector', () => {
  it('/healthでConnector情報を返す', async () => {
    const response = await app.request('/health', {}, testEnv);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: 'vrphoto-storage-connector',
      apiVersion: 'v1',
      connectorId: 'test-connector',
      storage: 'r2',
    });
  });

  it('setup WorkerがConnector IDと署名鍵を自動生成し、Storage Connectorが保存済み設定を使う', async () => {
    await testEnv.PHOTOS.delete(generatedConfigKey);
    await testEnv.PHOTOS.delete(setupTokenStateKey);
    await testEnv.PHOTOS.delete(setupTokenUrlKey);
    const setupEnv = {
      ...testEnv,
      CONNECTOR_ID: '',
      VRPHOTO_PUBLIC_KEY_JWK: '',
      CONNECTOR_URL: 'https://storage-connector.example.test',
    };

    const unauthenticatedSetupResponse = await setupApp.request('/setup', {}, setupEnv);
    expect(unauthenticatedSetupResponse.status).toBe(403);
    await expect(unauthenticatedSetupResponse.json()).resolves.toStrictEqual({ error: 'setup_token_required' });

    const tokenResponse = await setupApp.request('/setup-token', { method: 'POST' }, setupEnv);
    expect(tokenResponse.status).toBe(201);
    await expect(tokenResponse.json()).resolves.toMatchObject({
      created: true,
      tokenFileKey: setupTokenUrlKey,
      expiresAt: expect.any(String),
    });

    const tokenFile = await testEnv.PHOTOS.get(setupTokenUrlKey);
    expect(tokenFile).not.toBeNull();
    const tokenFileBody = await tokenFile!.text();
    const setupUrl = tokenFileBody.match(/https?:\/\/[^\s]+/)?.[0];
    expect(setupUrl).toContain('/setup?setupToken=');

    const setupResponse = await setupApp.request(setupUrl!, {}, setupEnv);

    expect(setupResponse.status).toBe(201);
    const setupBody = await setupResponse.json<{
      initialized: boolean;
      connector: {
        connectorId: string;
        connectorUrl: string;
        publicKeyJwk: string;
        privateKeyJwk: JsonWebKey;
      };
    }>();
    expect(setupBody.initialized).toBe(true);
    expect(setupBody.connector.connectorUrl).toBe('https://storage-connector.example.test');
    expect(setupBody.connector.connectorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(JSON.parse(setupBody.connector.publicKeyJwk)).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    expect(setupBody.connector.privateKeyJwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', d: expect.any(String) });

    const secondSetupResponse = await setupApp.request(setupUrl!, {}, setupEnv);
    expect(secondSetupResponse.status).toBe(409);
    await expect(secondSetupResponse.json()).resolves.toStrictEqual({ error: 'setup_already_completed' });

    const key = 'VRPotos/generated/4W3lkjP9Q.1.png';
    await testEnv.PHOTOS.put(key, new Uint8Array([1]), { httpMetadata: { contentType: 'image/png' } });
    const token = await signToken('read', {
      key,
      connectorId: setupBody.connector.connectorId,
      privateKeyJwk: setupBody.connector.privateKeyJwk,
    });

    const objectResponse = await app.request(`/v1/objects/${key}?token=${token}`, {}, setupEnv);

    expect(objectResponse.status).toBe(200);
  });

  it('Deploy Button用の任意envが未定義でも初期化フローを開始できる', async () => {
    await testEnv.PHOTOS.delete(generatedConfigKey);
    await testEnv.PHOTOS.delete(setupTokenStateKey);
    await testEnv.PHOTOS.delete(setupTokenUrlKey);
    const deployButtonEnv = {
      PHOTOS: testEnv.PHOTOS,
      ALLOWED_ORIGIN: testEnv.ALLOWED_ORIGIN,
    } as Env;

    const healthResponse = await app.request('/health', {}, deployButtonEnv);
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toMatchObject({
      connectorId: null,
      setupRequired: true,
    });

    const tokenResponse = await setupApp.request('/setup-token', { method: 'POST' }, deployButtonEnv);
    expect(tokenResponse.status).toBe(201);
    await expect(tokenResponse.json()).resolves.toMatchObject({
      created: true,
      tokenFileKey: setupTokenUrlKey,
    });
  });

  it('setup token発行済みの場合は同じR2ファイルを案内し、URL内token以外は拒否する', async () => {
    await testEnv.PHOTOS.delete(generatedConfigKey);
    await testEnv.PHOTOS.delete(setupTokenStateKey);
    await testEnv.PHOTOS.delete(setupTokenUrlKey);
    const setupEnv = { ...testEnv, CONNECTOR_ID: '', VRPHOTO_PUBLIC_KEY_JWK: '' };

    const firstTokenResponse = await setupApp.request('/setup-token', { method: 'POST' }, setupEnv);
    expect(firstTokenResponse.status).toBe(201);
    const secondTokenResponse = await setupApp.request('/setup-token', { method: 'POST' }, setupEnv);
    expect(secondTokenResponse.status).toBe(200);
    await expect(secondTokenResponse.json()).resolves.toMatchObject({ created: false, tokenFileKey: setupTokenUrlKey });

    const invalidSetupResponse = await setupApp.request('/setup?setupToken=invalid-token', {}, setupEnv);
    expect(invalidSetupResponse.status).toBe(403);
    await expect(invalidSetupResponse.json()).resolves.toStrictEqual({ error: 'setup_token_invalid' });
  });

  it('期限切れのsetup tokenでは/setupを処理しない', async () => {
    await testEnv.PHOTOS.delete(generatedConfigKey);
    await testEnv.PHOTOS.put(
      setupTokenStateKey,
      JSON.stringify({
        tokenHash: 'expired-token-hash',
        createdAt: '2000-01-01T00:00:00.000Z',
        expiresAt: '2000-01-01T01:00:00.000Z',
        setupUrl: 'http://localhost/setup?setupToken=expired',
      }),
      { httpMetadata: { contentType: 'application/json' } }
    );
    const setupEnv = { ...testEnv, CONNECTOR_ID: '', VRPHOTO_PUBLIC_KEY_JWK: '' };

    const response = await setupApp.request('/setup?setupToken=expired', {}, setupEnv);

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toStrictEqual({ error: 'setup_token_expired' });
  });

  it('Storage Connectorは/setupを受け付けない', async () => {
    const response = await app.request('/setup', { method: 'POST' }, testEnv);

    expect(response.status).toBe(404);
  });

  it('固定設定済みのSetup Workerは/setupを処理しない', async () => {
    const response = await setupApp.request('/setup', { method: 'POST' }, testEnv);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toStrictEqual({ error: 'setup_already_completed' });
  });

  it('署名トークンなしではR2へアクセスしない', async () => {
    const key = 'VRPotos/no-token/4W3lkjP9Q.3.png';
    await testEnv.PHOTOS.put(key, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'image/png' } });

    const response = await app.request(`/v1/objects/${key}`, {}, testEnv);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({ error: 'token_required' });
  });

  it('署名済みGETでR2オブジェクトをストリーミングし、HTTP MetadataとETagを返す', async () => {
    const key = 'VRPotos/read-ok/4W3lkjP9Q.4.png';
    await testEnv.PHOTOS.put(key, new Uint8Array([137, 80, 78, 71]), {
      httpMetadata: {
        contentType: 'image/png',
        cacheControl: 'private, max-age=300',
      },
    });
    const token = await signToken('read', { key });

    const response = await app.request(
      `/v1/objects/${key}?token=${token}`,
      {
        headers: { origin: 'https://vrphoto.example.test' },
      },
      testEnv
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('private, max-age=300');
    expect(response.headers.get('etag')).toBeTruthy();
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://vrphoto.example.test');
    expect([...new Uint8Array(await response.arrayBuffer())]).toStrictEqual([137, 80, 78, 71]);
  });

  it('Range付きGETで部分レスポンスを返す', async () => {
    const key = 'VRPotos/range-ok/4W3lkjP9Q.6.bin';
    await testEnv.PHOTOS.put(key, new Uint8Array([0, 1, 2, 3, 4, 5]), {
      httpMetadata: { contentType: 'application/octet-stream' },
    });
    const token = await signToken('read', { key });

    const response = await app.request(
      `/v1/objects/${key}?token=${token}`,
      {
        headers: { range: 'bytes=2-4' },
      },
      testEnv
    );

    expect(response.status).toBe(206);
    expect([...new Uint8Array(await response.arrayBuffer())]).toStrictEqual([2, 3, 4]);
  });

  it('If-None-Match付きGETで条件付き取得を処理する', async () => {
    const key = 'VRPotos/conditional-ok/4W3lkjP9Q.1.png';
    const object = await testEnv.PHOTOS.put(key, new Uint8Array([9]), { httpMetadata: { contentType: 'image/png' } });
    const token = await signToken('read', { key });

    const response = await app.request(
      `/v1/objects/${key}?token=${token}`,
      {
        headers: { 'if-none-match': object.httpEtag },
      },
      testEnv
    );

    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe(object.httpEtag);
  });

  it('PUT、HEAD、DELETEを署名済みトークンで処理する', async () => {
    const key = 'VRPotos/write-delete/4W3lkjP9Q.3.jpg';
    const writeToken = await signToken('write', { key, contentType: 'image/jpeg', maxBytes: 16 });

    const putResponse = await app.request(
      `/v1/objects/${key}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${writeToken}`,
          'content-type': 'image/jpeg',
          'content-length': '3',
        },
        body: new Uint8Array([1, 2, 3]),
      },
      testEnv
    );
    expect(putResponse.status).toBe(201);

    const headToken = await signToken('head', { key });
    const headResponse = await app.request(
      `/v1/objects/${key}`,
      {
        method: 'HEAD',
        headers: { authorization: `Bearer ${headToken}` },
      },
      testEnv
    );
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get('content-type')).toBe('image/jpeg');

    const deleteToken = await signToken('delete', { key });
    const deleteResponse = await app.request(
      `/v1/objects/${key}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${deleteToken}` },
      },
      testEnv
    );
    expect(deleteResponse.status).toBe(200);
    await expect(testEnv.PHOTOS.get(key)).resolves.toBeNull();
  });

  it('旧photos形式のオブジェクトキーは拒否する', async () => {
    const key = 'photos/legacy/original.png';
    const token = await signToken('read', { key });

    const response = await app.request(`/v1/objects/${key}?token=${token}`, {}, testEnv);

    expect(response.status).toBe(400);
  });

  it('VRPhoto形式のオブジェクトキーを署名済みPUTで保存できる', async () => {
    const key = 'VRPotos/originals/4W3lkjP9Q.8.png';
    const writeToken = await signToken('write', { key, contentType: 'image/png', maxBytes: 8 });

    const response = await app.request(
      `/v1/objects/${key}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${writeToken}`,
          'content-type': 'image/png',
          'content-length': '8',
        },
        body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      },
      testEnv
    );

    expect(response.status).toBe(201);
    await expect(testEnv.PHOTOS.get(key)).resolves.not.toBeNull();
  });

  it('Listは指定prefixと署名済みpayloadが一致する場合だけ返す', async () => {
    const prefix = 'VRPotos/list-ok/';
    const key = `${prefix}4W3lkjP9Q.1.png`;
    await testEnv.PHOTOS.put(key, new Uint8Array([1]), { httpMetadata: { contentType: 'image/png' } });
    const token = await signToken('list', { prefix });

    const response = await app.request(`/v1/objects?prefix=${encodeURIComponent(prefix)}&token=${token}`, {}, testEnv);

    expect(response.status).toBe(200);
    const body = await response.json<{ objects: Array<{ key: string }> }>();
    expect(body.objects.map((object) => object.key)).toContain(key);
  });
});

async function signToken(
  operation: TokenOperation,
  options: { key?: string; prefix?: string; contentType?: string; maxBytes?: number; connectorId?: string; privateKeyJwk?: JsonWebKey }
): Promise<string> {
  const { connectorId: connectorIdOption, privateKeyJwk: signingPrivateKeyJwk, ...claims } = options;
  const connectorId = connectorIdOption ?? 'test-connector';
  const now = Math.floor(Date.now() / 1000);
  const payload: AccessTokenPayload = {
    iss: 'vrphoto.example.test',
    aud: connectorId,
    sub: 'test-viewer',
    operation,
    iat: now,
    exp: now + 300,
    connectorId,
    ...claims,
  };
  const encodedHeader = base64UrlJson({ alg: 'EdDSA', typ: 'JWT' });
  const encodedPayload = base64UrlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const privateKey = await crypto.subtle.importKey('jwk', signingPrivateKeyJwk ?? privateKeyJwk, 'Ed25519', false, ['sign']);
  const encodedSigningInput = new TextEncoder().encode(signingInput);
  const signature = await crypto.subtle.sign(
    'Ed25519',
    privateKey,
    encodedSigningInput.buffer.slice(
      encodedSigningInput.byteOffset,
      encodedSigningInput.byteOffset + encodedSigningInput.byteLength
    ) as ArrayBuffer
  );

  return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
