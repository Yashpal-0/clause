/**
 * A registration that can be made again whenever it may have fallen behind
 * newer ones. VS Code consults file decoration providers newest first and takes
 * the label colour from the first one that has one, so being the newest
 * provider is what keeps our colour from losing to git's.
 *
 * Renewing registers the new one before it lets the old one go, so a
 * registration that fails leaves the old one in place, and waits for the end of
 * the turn, so that whatever else is registered in the same turn (git's
 * providers, when it reacts to the same event) comes first and ours ends up
 * the newest. Renewals asked for within one turn are one renewal.
 */
export class NewestRegistration {
  readonly #register: () => { dispose(): void };
  readonly #onError: (error: unknown) => void;
  #current: { dispose(): void };
  #queued = false;
  #disposed = false;

  /** Registers at once. A failure of this first registration is the caller's to handle. */
  constructor(register: () => { dispose(): void }, onError: (error: unknown) => void) {
    this.#register = register;
    this.#onError = onError;
    this.#current = register();
  }

  renew(): void {
    if (this.#queued) return;
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      if (this.#disposed) return;
      try {
        const next = this.#register();
        const old = this.#current;
        this.#current = next;
        old.dispose();
      } catch (error) {
        this.#onError(error);
      }
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#current.dispose();
  }
}
