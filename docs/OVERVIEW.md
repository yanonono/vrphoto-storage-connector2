# 全体像

VRPhoto では、写真管理サイト本体と写真ファイルの保存先を分けています。

このリポジトリは、用途の違う2つの Cloudflare Workers を提供します。

| Worker | 設定ファイル | 役割 |
| --- | --- | --- |
| Storage Connector Worker | `wrangler.jsonc` | 写真管理サイトからの署名付きリクエストを検証し、R2 bucket の写真ファイルを保存、取得、削除、一覧取得します。 |
| Setup Worker | `wrangler.setup.jsonc` | 初期セットアップだけを受け付け、Connector ID と Ed25519 鍵ペアを生成します。生成した公開鍵はR2に保存し、秘密鍵は初回レスポンスでだけ返します。 |

## 初期セットアップ時

```text
管理者または利用者
  ↓ POST /setup-token
Setup Worker
  ↓ setup token付きURLをR2へ保存
Cloudflare R2 bucket
  ↓ Cloudflare Web ConsoleでURLを確認して開く
Setup Worker
  ↓ Connector ID と公開鍵を保存
Cloudflare R2 bucket
```

初期設定は Storage Connector とは別の Setup Worker で受け付けます。

Setup Worker は `POST /setup-token` で setup token付きURLをR2へ保存します。管理者または利用者は Cloudflare Web Console でそのファイル内容を確認し、URLを開いて初期セットアップを実行します。

初期セットアップでは Connector ID と Ed25519 鍵ペアを生成します。生成した公開鍵は同じ R2 bucket に保存し、秘密鍵は初回レスポンスでだけ返します。

## 通常利用時

```text
ブラウザ
  ↓
VRPhoto 写真管理サイト
  ↓ 署名付きリクエスト
Storage Connector Worker
  ↓
Cloudflare R2 bucket
```

通常利用時は、写真管理サイトから送られてきた署名付きトークンを Storage Connector Worker が確認してから、R2 に対して写真の保存、取得、削除、一覧取得を行います。

重要な点は、写真管理サイトが R2 の管理用 Access Key や Secret Key を直接持たないことです。Connector は Cloudflare Workers 上で動き、Cloudflare の binding という仕組みで R2 bucket に接続します。
