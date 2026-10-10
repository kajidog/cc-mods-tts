/** An unbounded queue whose `take` waits for the next item. */
export class Channel<T> {
  private items: T[] = []
  private waiter: (() => void) | undefined

  get size(): number {
    return this.items.length
  }

  push(item: T) {
    this.items.push(item)
    this.waiter?.()
    this.waiter = undefined
  }

  async take(): Promise<T> {
    while (this.items.length === 0) await new Promise<void>(resolve => (this.waiter = resolve))
    return this.items.shift() as T
  }
}
