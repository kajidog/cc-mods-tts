---
"cc-mods-tts": patch
---

読み上げに失敗してもトーストを出さないようにした。エンジンが落ちている間はステータス行の `⚠ tts: voicevox down` で分かり、失敗の詳細は debug ログに残る。
