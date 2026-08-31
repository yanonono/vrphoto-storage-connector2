# VRPhoto Storage Connector

VRPhoto Storage Connector は、VRPhoto の写真ファイルを Cloudflare R2 に保存するための Web API です。
このリポジトリは、用途の違う2つの Cloudflare Workers を提供します。

| Worker | 設定ファイル | 役割 |
| --- | --- | --- |
| Storage Connector Worker | `wrangler.jsonc` | 写真管理サイトからの署名付きリクエストを検証し、R2 bucket の写真ファイルを保存、取得、削除、一覧取得します。 |
| Setup Worker | `wrangler.setup.jsonc` | 初期セットアップだけを受け付け、Connector ID と Ed25519 鍵ペアを生成します。生成した公開鍵はR2に保存し、秘密鍵は初回レスポンスでだけ返します。 |

この README では、Connector の役割と主要な導線だけを説明します。

## この Connector ができること

- `PUT` で写真ファイルを R2 に保存する
- `GET` で写真ファイルを R2 から取得する
- `HEAD` で写真ファイルのメタデータだけ確認する
- `DELETE` で写真ファイルを削除する
- `GET /v1/objects?prefix=` で指定 prefix のオブジェクト一覧を取得する
- `POST /pair` で写真管理サイトに登録する Connector 情報を返す
- `GET /health` で起動確認をする
- Setup Worker の `POST /setup-token` でR2内にsetup token付きURLを作成する
- Setup Worker の `GET /setup?setupToken=...` で Connector ID と署名鍵を初期生成する

すべての R2 操作は、写真管理サイトが発行した署名付きトークンを検証してから実行します。

Setup Worker は初期セットアップ専用です。初期化後は削除ではなく、無効化しておく運用を推奨します。

## インストール・セットアップ

Cloudflareへのインストール、R2 bucket作成、Storage Connector WorkerとSetup Workerのデプロイ、setup token付きURLによる初期セットアップは [docs/SETUP.md](./docs/SETUP.md) を参照してください。

このREADMEおよび関連ドキュメント内で `{...}` と書かれている値はサンプルです。公開環境では必ず実際の値へ置き換えてください。

## 技術リファレンス

API、Cloudflare用語、署名トークン、保存できるオブジェクトキー、エラー一覧は [docs/REFERENCE.md](./docs/REFERENCE.md) を参照してください。

## 変更履歴

### 2026-08-31

- Cloudflare Deploy Button使用時、必須項目の見直し
- Cloudflare Workers Builds の エラー対応

## 関連ドキュメント

- [全体像](./docs/OVERVIEW.md)
- [インストール・セットアップ](./docs/SETUP.md)
- [技術リファレンス](./docs/REFERENCE.md)
- [開発・公開リリース補足](./docs/DEVELOPMENT.md)
- [セキュリティポリシー](./docs/SECURITY.md)

## ライセンス

MIT License です。詳細は [LICENSE.md](./LICENSE.md) を参照してください。
