import type { HookStream, ProcessSpawnChunk, ProcessSpawnResult } from "claude-code"

/** One synthesis or playback process; closing its stream also kills the child. */
export class SpeechProcess {
  private stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined

  get isRunning(): boolean {
    return this.stream !== undefined
  }

  async stop(): Promise<void> {
    await this.stream?.return({ code: null, signal: "SIGTERM" }).catch(() => undefined)
  }

  /** `onStderr` is given the stderr read so far each time more comes. */
  async read(stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>, onStderr?: (stderr: string) => void) {
    this.stream = stream
    // Closing a stream rejects its result; observe that rejection even during cancellation.
    const result = stream.result.catch(() => ({ code: null, signal: "SIGTERM" }))
    let stdout = ""
    let stderr = ""
    try {
      for await (const piece of stream) {
        // Bound output so a noisy command cannot fill memory.
        if (piece.stream === "stdout") stdout = (stdout + piece.text).slice(0, 4_194_304)
        else {
          stderr = (stderr + piece.text).slice(0, 4_194_304)
          onStderr?.(stderr)
        }
      }
      return { ...(await result), stdout, stderr }
    } finally {
      if (this.stream === stream) this.stream = undefined
    }
  }
}
