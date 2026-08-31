# 技術リファレンス

この文書では、VRPhoto Storage Connector のCloudflare用語、API、署名トークン、オブジェクトキー、エラーを説明します。

## Cloudflare の用語

Cloudflare で使う主な用語は次のとおりです。

| 用語 | このプロジェクトでの意味 |
| --- | --- |
| Cloudflare account | Cloudflare の利用単位です。個人やチームごとに作ります。 |
| Workers | サーバーを自分で用意せず、Cloudflare 上で TypeScript / JavaScript の API を動かす仕組みです。 |
| R2 | 画像や動画などのファイルを保存する Cloudflare のオブジェクトストレージです。AWS S3 に近いものです。 |
| bucket | R2 の中でファイルを入れる箱です。この Connector では写真ファイルを入れます。 |
| Wrangler | Cloudflare Workers や R2 をコマンドラインから操作する公式ツールです。 |
| binding | Worker のコードから R2 bucket などを使えるようにする接続設定です。 |

Cloudflare 公式ドキュメントでは、Cloudflare account の作成、Wrangler による R2 bucket 作成、Workers から R2 を使う方法が説明されています。

- Cloudflare account 作成: https://developers.cloudflare.com/fundamentals/account/create-account/
- R2 bucket 作成: https://developers.cloudflare.com/r2/buckets/create-buckets/
- Workers から R2 を使う: https://developers.cloudflare.com/r2/get-started/workers-api/
- Wrangler 設定: https://developers.cloudflare.com/workers/wrangler/configuration/

## API

Storage Connector Worker の API:

| Method | Path | 認証 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/health` | 不要 | 起動確認 |
| `POST` | `/pair` | 必要 | Connector 情報の返却または写真管理サイトへのコールバック |
| `GET` | `/v1/objects?prefix=` | 必要 | prefix に一致するオブジェクト一覧 |
| `PUT` | `/v1/objects/{key}` | 必要 | 写真ファイルの保存 |
| `GET` | `/v1/objects/{key}` | 必要 | 写真ファイルの取得 |
| `HEAD` | `/v1/objects/{key}` | 必要 | 写真ファイルのメタデータ確認 |
| `DELETE` | `/v1/objects/{key}` | 必要 | 写真ファイルの削除 |

Setup Worker の API:

| Method | Path | 認証 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/health` | 不要 | Setup Worker の起動確認 |
| `POST` | `/setup-token` | HTTP認証なし | R2 bucket内にsetup token付きURLファイルを作成 |
| `GET` | `/setup?setupToken=...` | setup token | Connector ID と署名鍵の初期生成 |
| `POST` | `/setup?setupToken=...` | setup token | Connector ID と署名鍵の初期生成 |

`POST /setup-token` 自体はHTTP認証なしで呼び出せます。ただし、セットアップを完了するために必要なURLはR2 bucket内の `.vrphoto/setup-token-url.txt` に保存されるため、R2 bucket内容を確認できる人だけが `/setup?setupToken=...` へ進めます。

`GET /v1/objects/{key}` は、`Range` や `If-None-Match` などの HTTP header を R2 に渡します。大きな画像やキャッシュ確認で使います。

## 署名トークン

R2 操作には署名トークンが必要です。

この Connector は、JWT 風の次の形式を受け取ります。

```text
base64url(header).base64url(payload).base64url(signature)
```

`header.alg` は `EdDSA`、署名検証は Ed25519 です。

例:

```json
{
  "iss": "vrphoto.example",
  "aud": "connector-id",
  "sub": "viewer-or-session-id",
  "key": "VRPotos/originals/4W3lkjP9Q.8.jpg",
  "operation": "read",
  "iat": 1787932200,
  "exp": 1787932800,
  "connectorId": "connector-id"
}
```

`operation` には次の値を使います。

| operation | 意味 |
| --- | --- |
| `pair` | Connector 登録 |
| `list` | 一覧取得 |
| `write` | 保存 |
| `read` | 取得 |
| `head` | メタデータ確認 |
| `delete` | 削除 |

`list` の場合は `key` の代わりに `prefix` を使います。

`write` の場合は、必要に応じて `contentType` と `maxBytes` を含めます。Connector は実際のリクエストの `Content-Type` と `Content-Length` を確認し、署名された条件と違う場合は拒否します。

## 保存できるオブジェクトキー

Connector は、想定外の R2 パスへアクセスされないように、保存・取得できる key の形式を制限しています。

現在許可している形式:

```text
VRPotos/{dirName}/{hash}.{size}.{ext}
```

この形式に一致しない key は、署名トークンが正しくても `object_key_invalid` として拒否します。

## よくあるエラー

| エラー | 原因 | 対応 |
| --- | --- | --- |
| `connector_setup_required` | Connector ID と公開鍵が未設定 | Setup Workerで初期セットアップを完了します。 |
| `connector_config_invalid` | R2 bucket内の `.vrphoto/connector-config.json` をJSONとして読めない | 設定ファイルを確認し、必要なら再セットアップします。 |
| `internal_server_error` | Connector内部で予期しないエラーが発生した | Workerのログを確認します。 |
| `object_not_found` | 指定したkeyのオブジェクトがR2 bucketに存在しない | keyが正しいか、対象ファイルが保存済みか確認します。 |
| `pairing_callback_failed` | `SITE_PAIRING_ENDPOINT` への送信に失敗した | 写真管理サイト側のペアリング受信用URLとレスポンスを確認します。 |
| `public_key_invalid` | 公開鍵JWKを読み込めない | `VRPHOTO_PUBLIC_KEY_JWK` または `.vrphoto/connector-config.json` の公開鍵を確認します。 |
| `request_body_required` | `PUT` のリクエストbodyがない | 写真ファイルのbodyを付けてアップロードします。 |
| `token_required` | token が付いていない | `Authorization: Bearer ...` または `?token=...` を付けます。 |
| `token_format_invalid` | token が `header.payload.signature` 形式ではない | 写真管理サイト側の署名トークン生成処理を確認します。 |
| `token_header_invalid` | token header の `alg` または `typ` が想定と違う | `alg: EdDSA`、`typ: JWT` で発行します。 |
| `token_json_invalid` | token header または payload をJSONとして読めない | base64urlエンコードとJSON文字列を確認します。 |
| `token_signature_invalid` | 署名検証に失敗した | 写真管理サイトの秘密鍵と Connector の公開鍵がペアになっているか確認します。 |
| `token_expired` | token の有効期限が切れた | 写真管理サイト側で新しい短時間tokenを発行します。 |
| `token_iat_invalid` | token の発行時刻が未来すぎる | 写真管理サイト側の時刻設定を確認します。 |
| `token_audience_invalid` | token の `aud` / `connectorId` が `CONNECTOR_ID` と違う | 写真管理サイト側の Connector ID 設定を確認します。 |
| `token_operation_invalid` | token の operation と API の操作が違う | `read` 用 token で `PUT` していないか確認します。 |
| `token_key_invalid` | token の `key` とURL上のkeyが一致しない | 署名対象のkeyと実際のリクエスト先keyを合わせます。 |
| `token_prefix_invalid` | token の `prefix` と一覧取得時のprefixが一致しない | 署名対象のprefixと実際のqueryを合わせます。 |
| `object_key_invalid` | key の形式が許可されていない | 許可されている key 形式に合わせます。 |
| `content_type_not_allowed` | `write` token の `contentType` と実際の `Content-Type` が違う | 署名時とアップロード時の Content-Type を合わせます。 |
| `content_length_too_large` | `write` token の `maxBytes` を超えた | 写真サイズを見直すか、署名時の上限を変更します。 |
| `setup_token_state_invalid` | R2 bucket内の `.vrphoto/setup-token.json` をJSONとして読めない | setup token関連ファイルを削除し、`POST /setup-token` を再実行します。 |
| `setup_token_required` | setup token付きURLを使わずに `/setup` を呼び出した | R2 bucket内の `.vrphoto/setup-token-url.txt` にあるURLを開きます。 |
| `setup_token_invalid` | setup tokenが一致しない | 最新の `.vrphoto/setup-token-url.txt` にあるURLを使います。 |
| `setup_token_expired` | setup token付きURLの有効期限が切れた | `POST /setup-token` を再実行し、新しいURLをR2 bucket内で確認します。 |
| `setup_already_completed` | 既に初期セットアップ済み | 追加の `/setup` は不要です。Storage Connector の `/health` を確認します。 |
