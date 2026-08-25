/**
 * Minimal strongly-typed event emitter (no `any` leaks in the public API;
 * the internal alias only relaxes the generic constraint so event maps
 * with typed parameters (e.g. `(err: Error) => void`) are accepted).
 */
type AnyFn = (...args: any[]) => void;

export class TypedEmitter<Events extends Record<keyof Events, AnyFn>> {
  private listeners = new Map<keyof Events, Set<AnyFn>>();

  on<E extends keyof Events>(event: E, listener: Events[E]): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as AnyFn);
    return this;
  }

  off<E extends keyof Events>(event: E, listener: Events[E]): this {
    this.listeners.get(event)?.delete(listener as AnyFn);
    return this;
  }

  protected emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.error(`[unified-realtime-asr] listener for "${String(event)}" threw:`, err);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
