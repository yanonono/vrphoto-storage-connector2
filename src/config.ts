import { HTTPException } from 'hono/http-exception';
import type { ConnectorAuthConfig, Env, StoredConnectorConfig } from './types';

export const apiVersion = 'v1';
export const connectorConfigKey = '.vrphoto/connector-config.json';

export async function requireConnectorConfig(env: Env): Promise<ConnectorAuthConfig> {
  // R2操作系APIでは初期設定が完了していない状態を明示的に503で返す。
  const config = await readConnectorConfig(env);
  if (!config) {
    throw new HTTPException(503, { message: 'connector_setup_required' });
  }

  return config;
}

export async function readConnectorConfig(env: Env): Promise<ConnectorAuthConfig | null> {
  const envConnectorId = normalizeOptionalEnv(env.CONNECTOR_ID);
  const envPublicKeyJwk = normalizeOptionalEnv(env.VRPHOTO_PUBLIC_KEY_JWK);
  if (envConnectorId && envPublicKeyJwk) {
    // 手動固定した設定がある場合は、R2内の自動生成設定より優先する。
    return { connectorId: envConnectorId, publicKeyJwk: envPublicKeyJwk };
  }

  // Deploy Button利用時は空のvarsでデプロイし、Setup WorkerがR2へ保存した設定を読む。
  const stored = await readStoredConnectorConfig(env);
  return stored ? { connectorId: stored.connectorId, publicKeyJwk: stored.publicKeyJwk } : null;
}

export async function readStoredConnectorConfig(env: Env): Promise<StoredConnectorConfig | null> {
  // 設定は写真と同じ利用者所有R2 bucket内に保存し、別DBやSecret管理を不要にする。
  const object = await env.PHOTOS.get(connectorConfigKey);
  if (!object) {
    return null;
  }

  try {
    return JSON.parse(await object.text()) as StoredConnectorConfig;
  } catch {
    throw new HTTPException(500, { message: 'connector_config_invalid' });
  }
}

export async function generateConnectorConfig(): Promise<{ storedConfig: StoredConnectorConfig; privateKeyJwk: JsonWebKey }> {
  const keyPair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  // 秘密鍵はConnectorに保存せず、写真管理サイトへ設定するため初回setupレスポンスでだけ返す。
  const storedConfig = {
    connectorId: crypto.randomUUID(),
    publicKeyJwk: JSON.stringify(publicKeyJwk),
    createdAt: new Date().toISOString(),
  };

  return { storedConfig, privateKeyJwk };
}

export function setupConnectorPayload(
  request: Request,
  config: ConnectorAuthConfig,
  connectorUrlOverride?: string
): {
  connectorId: string;
  connectorUrl: string;
  apiVersion: string;
  publicKeyJwk: string;
} {
  return {
    connectorId: config.connectorId,
    // Setup Worker自身のURLではなく、Storage Connectorの公開URLを返せるように上書きを許可する。
    connectorUrl: connectorUrlOverride || new URL(request.url).origin,
    apiVersion,
    publicKeyJwk: config.publicKeyJwk,
  };
}

export function normalizeOptionalEnv(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  // Deploy Buttonのプレースホルダー値を未設定として扱う。
  return trimmed.startsWith('replace-with-') ? '' : trimmed;
}
