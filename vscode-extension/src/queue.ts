/**
 * Runs asynchronous tasks one at a time per key. Operations on one file read
 * its state, change it and write it back, so two of them overlapping would
 * act on a state the other has already changed.
 */
export class KeyedQueue {
  readonly #tails = new Map<string, Promise<void>>();

  /** How many keys have work queued or running. */
  get size(): number {
    return this.#tails.size;
  }

  /** Runs `task` after everything queued before it under `key`; its failure is its caller's alone. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.#tails.get(key) ?? Promise.resolve()).then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }
}
