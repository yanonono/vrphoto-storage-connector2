# 開発・公開リリース補足

このドキュメントでは、開発時に使うコマンドと、公開リリース時に含めないファイルをまとめます。

This document summarizes development commands and files that should not be included in a public release.

## 開発用コマンド

```bash
pnpm install
pnpm run check
pnpm run test
pnpm run dev
pnpm run dev:setup
pnpm run deploy
pnpm run deploy:setup
```

| コマンド | 内容 |
| --- | --- |
| `pnpm install` | 依存パッケージをインストールします。 |
| `pnpm run check` | TypeScript の型チェックをします。 |
| `pnpm run test` | 単体テストを実行します。 |
| `pnpm run dev` | ローカルで Storage Connector Worker を起動します。 |
| `pnpm run dev:setup` | ローカルで Setup Worker を起動します。 |
| `pnpm run deploy` | Storage Connector Worker を Cloudflare Workers へデプロイします。 |
| `pnpm run deploy:setup` | Setup Worker を Cloudflare Workers へデプロイします。 |

## 公開リリース時に含めないもの

このリポジトリでは、ローカル開発やデプロイ時に生成されるファイル、秘密情報を含む可能性があるファイルを公開リリースに含めません。

`.gitignore` と公開同期スクリプトでは、少なくとも次のパスを除外します。

```text
.dev.vars
.dev.vars.*
.wrangler/
node_modules/
coverage/
```

`.dev.vars` と `.dev.vars.*` にはローカル用の秘密情報が入る可能性があります。`.wrangler/`、`node_modules/`、`coverage/` はローカル環境で生成されるため、公開リポジトリには含めません。
