export type Env = {
  // Storage ConnectorとSetup Workerが共有する写真保存先R2 bucket。
  PHOTOS: R2Bucket;
  // 固定設定で使うConnector ID。未設定の場合はR2内の自動生成設定を読む。
  CONNECTOR_ID?: string;
  // 固定設定で使うEd25519公開鍵JWK。秘密鍵はWorkerに保存しない。
  VRPHOTO_PUBLIC_KEY_JWK?: string;
  // Setup Workerが返すStorage Connectorの公開URL。
  CONNECTOR_URL?: string;
  ALLOWED_ORIGIN: string;
  SITE_PAIRING_ENDPOINT?: string;
};

export type ConnectorAuthConfig = {
  // 署名トークンのaud/connectorIdと照合するConnector識別子。
  connectorId: string;
  // 写真管理サイトが発行した短時間トークンを検証する公開鍵。
  publicKeyJwk: string;
};

export type StoredConnectorConfig = ConnectorAuthConfig & {
  createdAt: string;
};

export type TokenOperation = 'read' | 'write' | 'head' | 'delete' | 'list' | 'pair';

export type AccessTokenPayload = {
  // iss/subは監査や呼び出し元識別に使い、aud/connectorIdは対象Connector固定に使う。
  iss: string;
  aud: string;
  sub: string;
  key?: string;
  prefix?: string;
  operation: TokenOperation;
  iat: number;
  exp: number;
  contentType?: string;
  maxBytes?: number;
  photoId?: string;
  userId?: string;
  connectorId?: string;
};
