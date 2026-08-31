# Security Policy

この文書では日本語の記述内容を正とします。英語の記述は簡易翻訳であり、日本語と英語の内容に差異がある場合は日本語を優先します。

This document is authoritative in Japanese. The English text is a simple translation. If there is any difference between the Japanese and English text, the Japanese text takes precedence.

## 脆弱性の報告

VRPhoto Storage Connector の脆弱性を見つけた場合は、公開Issueには詳細を書かず、次の連絡先へメールで報告してください。

```text
yano.nono.0701+security@gmail.com
```

報告には、可能な範囲で次の情報を含めてください。

- 影響を受けるバージョンまたはcommit
- 再現手順
- 想定される影響
- 関連するログ、リクエスト、レスポンス
- 修正案がある場合はその概要

## Reporting a Vulnerability

If you find a vulnerability in VRPhoto Storage Connector, do not post the details in a public Issue. Please report it by email to the following contact.

```text
yano.nono.0701+security@gmail.com
```

Please include the following information when possible.

- Affected version or commit
- Steps to reproduce
- Expected impact
- Related logs, requests, and responses
- Summary of a possible fix, if available

## 注意事項

秘密鍵、アクセストークン、Cloudflare account ID、R2 bucket内の非公開オブジェクトキーなどの機密情報は、公開Issue、Pull Request、SNSへ投稿しないでください。

報告内容を確認後、必要に応じて修正、リリース、影響範囲の案内を行います。

## Notes

Do not post sensitive information such as private keys, access tokens, Cloudflare account IDs, or private object keys in an R2 bucket to public Issues, Pull Requests, or social media.

After reviewing the report, we will provide fixes, releases, and impact information as needed.
