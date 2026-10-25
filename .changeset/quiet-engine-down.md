---
"cc-mods-tts": patch
---

エンジンが落ちている間、ステータス行に `⚠ tts: voicevox down` を出し続けないようにした。状態は `/tts engine` と `{ plugin: "tts", key: "engine" }` で確認できる。
