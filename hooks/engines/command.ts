import type { Engine } from "./engine"

/** Any command: argv split on spaces, `{out}` the wav to write, the text on stdin. */
export const command: Engine = {
  load: options => {
    const template = String(options.command)
    const program = template.split(/\s+/).find(Boolean)
    return {
      voice: template || "(unset)",
      location: template || "(unset)",
      probe: program === undefined ? undefined : ["sh", "-c", 'command -v "$1" >/dev/null', "probe", program],
      synthesis: (text, out) => {
        const argv = template.split(/\s+/).filter(Boolean).map(arg => arg.replaceAll("{out}", out))
        if (argv.length === 0) throw new Error("command is not set (/config → tts)")
        return [{ argv, stdin: text }]
      },
    }
  },
}
