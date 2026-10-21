import { curlPost, curlProbe, type Engine, type Step, trimSlash } from "./engine"

/** VOICEVOX and engines with its API (AivisSpeech, COEIROINK v1). */
export const voicevox: Engine = {
  load: options => {
    const url = trimSlash(String(options.voicevoxUrl))
    const speaker = Number(options.voicevoxSpeaker)
    const query = (text: string): Step => ({ argv: curlPost(`${url}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`) })
    const withSpeed = (queried: string) => JSON.stringify({ ...JSON.parse(queried), speedScale: Number(options.speed) })
    return {
      voice: `speaker ${speaker}`,
      location: url,
      probe: curlProbe(`${url}/version`),
      synthesis: (text, out) => [query(text), { argv: curlPost(`${url}/synthesis?speaker=${speaker}`, out), stdin: withSpeed }],
      // VOICEVOX 0.26 and later; shorter segments start no sooner and finish later.
      stream: text => [
        query(text),
        { argv: curlPost(`${url}/streaming_synthesis?speaker=${speaker}&segment_length=1`, "-"), stdin: withSpeed },
      ],
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
