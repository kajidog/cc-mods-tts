import { curlPost, curlProbe, type Engine, trimSlash } from "./engine"

/** Irodori-TTS: an OpenAI-style /v1/audio/speech with reference voices. */
export const irodori: Engine = {
  load: options => {
    const url = trimSlash(String(options.irodoriUrl))
    const voice = String(options.irodoriVoice)
    return {
      voice: voice || "voice unset: /tts voice",
      location: url,
      probe: curlProbe(`${url}/health`),
      synthesis: (text, out) => {
        if (voice === "") throw new Error("irodoriVoice is not set (/config → tts)")
        const body = JSON.stringify({
          model: "irodori-tts",
          input: text,
          voice,
          response_format: "wav",
          speed: Number(options.speed),
        })
        return [{ argv: curlPost(`${url}/v1/audio/speech`, out), stdin: body }]
      },
      voices: {
        url: `${url}/v1/audio/voices`,
        parse: body => (JSON.parse(body) as { data: { id: string }[] }).data.map(listed => ({ value: listed.id })),
        current: voice,
        select: id => ({ key: "tts.irodoriVoice", value: id }),
      },
    }
  },
}
