import type { AccessTokenPayload, ConnectorAuthConfig, TokenOperation } from './types';

export class TokenError extends Error {}

export type VerifyTokenOptions = {
  operation: TokenOperation;
  key?: string;
  prefix?: string;
};

export async function verifyAccessToken(
  config: ConnectorAuthConfig,
  token: string | null,
  options: VerifyTokenOptions
): Promise<AccessTokenPayload> {
  if (!token) {
    throw new TokenError('token_required');
  }

  // 署名対象を曖昧にしないため、JWT風の3要素形式だけを受け付ける。
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new TokenError('token_format_invalid');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson<{ alg?: string; typ?: string }>(encodedHeader);
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT') {
    // ConnectorはEd25519署名だけを信頼し、alg差し替えを拒否する。
    throw new TokenError('token_header_invalid');
  }

  const publicKey = await importPublicKey(config.publicKeyJwk);
  const signedBytes = textBytes(`${encodedHeader}.${encodedPayload}`);
  const signatureBytes = base64UrlToBytes(encodedSignature);
  // payloadの内容を信頼する前に、必ず署名を検証する。
  const verified = await crypto.subtle.verify('Ed25519', publicKey, toArrayBuffer(signatureBytes), toArrayBuffer(signedBytes));
  if (!verified) {
    throw new TokenError('token_signature_invalid');
  }

  const payload = decodeJson<AccessTokenPayload>(encodedPayload);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.exp <= nowSeconds) {
    // 短時間トークンだけを許可し、漏えい時の有効期間を抑える。
    throw new TokenError('token_expired');
  }

  if (payload.iat > nowSeconds + 60) {
    // クライアント時計ずれを少し許容しつつ、未来発行トークンは拒否する。
    throw new TokenError('token_iat_invalid');
  }

  if (payload.aud !== config.connectorId || payload.connectorId !== config.connectorId) {
    // 別Connector向けに発行されたトークンを流用できないようにする。
    throw new TokenError('token_audience_invalid');
  }

  if (payload.operation !== options.operation) {
    throw new TokenError('token_operation_invalid');
  }

  if (options.key !== undefined && payload.key !== options.key) {
    // URL上のkeyと署名済みpayloadのkeyは完全一致のみ許可する。
    throw new TokenError('token_key_invalid');
  }

  if (options.prefix !== undefined && payload.prefix !== options.prefix) {
    // Listでは署名されたprefixだけを列挙対象にする。
    throw new TokenError('token_prefix_invalid');
  }

  return payload;
}

function decodeJson<T>(encoded: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded))) as T;
  } catch {
    throw new TokenError('token_json_invalid');
  }
}

async function importPublicKey(publicKeyJwk: string): Promise<CryptoKey> {
  try {
    const jwk = JSON.parse(publicKeyJwk) as JsonWebKey;
    return crypto.subtle.importKey('jwk', jwk, 'Ed25519', false, ['verify']);
  } catch {
    throw new TokenError('public_key_invalid');
  }
}

function base64UrlToBytes(value: string): Uint8Array {
  // JWTのbase64url表現をWeb標準のatobで扱えるbase64へ戻す。
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
