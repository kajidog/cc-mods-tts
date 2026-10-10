import { curlPost, curlProbe, type Engine, trimSlash } from "./engine"

/** VOICEVOX and engines with its API (AivisSpeech, COEIROINK v1). */
export const voicevox: Engine = {
  load: options => {
    const url = trimSlash(String(options.voicevoxUrl))
    const speaker = Number(options.voicevoxSpeaker)
    return {
      voice: `speaker ${speaker}`,
      location: url,
      probe: curlProbe(`${url}/version`),
      synthesis: (text, out) => {
        const query = `${url}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`
        return [
          { argv: curlPost(query) },
          {
            argv: curlPost(`${url}/synthesis?speaker=${speaker}`, out),
            stdin: queried => JSON.stringify({ ...JSON.parse(queried), speedScale: Number(options.speed) }),
          },
        ]
      },
      voices: {
        url: `${url}/speakers`,
        parse: body =>
          (JSON.parse(body) as { name: string; styles: { id: number; name: string }[] }[]).flatMap(listed =>
            listed.styles.map(style => ({ value: String(style.id), label: `${listed.name} ${style.name}` })),
          ),
        current: String(speaker),
        select: id => ({ key: "tts.voicevoxSpeaker", value: Number(id) }),
      },
    }
  },
}
