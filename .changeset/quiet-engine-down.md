---
"cc-mods-tts": patch
---

読み上げに失敗してもトーストを出さず、エンジンが落ちている間もステータス行に `⚠ tts: voicevox down` を出さないようにした。失敗は debug ログに残る。状態は `/tts engine` と `{ plugin: "tts", key: "engine" }` で確認できる。
