/**
 * An action that runs once the triggers stop coming: every trigger restarts the
 * delay, so a burst of events (keystrokes, file system notifications) costs one
 * run. It can be run early with `flush`, which is how pending work is finished
 * before the extension shuts down.
 */
export class Delayed {
  readonly #action: () => void;
  readonly #delayMs: number;
  #timer: NodeJS.Timeout | undefined;

  constructor(action: () => void, delayMs: number) {
    this.#action = action;
    this.#delayMs = delayMs;
  }

  get scheduled(): boolean {
    return this.#timer !== undefined;
  }

  trigger(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.flush(), this.#delayMs);
  }

  cancel(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Runs the action now if it is scheduled. */
  flush(): void {
    if (this.#timer === undefined) return;
    this.cancel();
    this.#action();
  }
}
