# 変更メモ

ユーザー向けの変更をしたら、`npm run changeset` でメモを追加し、コードと一緒にコミットしてください。
不具合修正は `patch`、機能追加は `minor`、互換性のない変更は `major` を選びます。
説明は、その変更で何ができるようになったか・何が直ったかを日本語で書きます。
ドキュメントや CI だけの変更では、メモは不要です。

main にマージされると、GitHub Actions がメモをまとめてリリース用 PR を作成・更新します。
PR には `CHANGELOG.md`、`package.json`、`package-lock.json`、`.claude-plugin/plugin.json` の更新と、取り込んだメモの削除が含まれます。

手動で同じ更新を生成する場合は `npm run release:version` を実行します。
プラグインのバージョンも同期するため、`changeset version` 単体では実行しないでください。

詳しい運用と GitHub の初期設定は [README](../README.md#変更履歴とリリース) を参照してください。
