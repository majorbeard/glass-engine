// A tiny typed event emitter - the public subscription surface for GlassClient.
// Kept dependency-free and DOM-free (no EventTarget) so the core stays usable
// in any JS environment, not just a browser main thread.

export type Listener<Args extends unknown[]> = (...args: Args) => void;

export class Emitter<EventMap extends Record<string, unknown[]>> {
  private listeners: {
    [K in keyof EventMap]?: Set<Listener<EventMap[K]>>;
  } = {};

  // Subscribe to an event. Returns an unsubscribe function.
  on<K extends keyof EventMap>(
    event: K,
    listener: Listener<EventMap[K]>
  ): () => void {
    let set = this.listeners[event];
    if (!set) {
      set = new Set();
      this.listeners[event] = set;
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  // Subscribe for a single emission, then auto-unsubscribe.
  once<K extends keyof EventMap>(
    event: K,
    listener: Listener<EventMap[K]>
  ): () => void {
    const wrapped: Listener<EventMap[K]> = (...args) => {
      off();
      listener(...args);
    };
    const off = this.on(event, wrapped);
    return off;
  }

  off<K extends keyof EventMap>(
    event: K,
    listener: Listener<EventMap[K]>
  ): void {
    this.listeners[event]?.delete(listener);
  }

  protected emit<K extends keyof EventMap>(
    event: K,
    ...args: EventMap[K]
  ): void {
    const set = this.listeners[event];
    if (!set) return;
    // Copy before iterating so a listener that unsubscribes (or subscribes)
    // during dispatch doesn't mutate the set mid-iteration.
    for (const listener of [...set]) {
      listener(...args);
    }
  }

  protected removeAllListeners(): void {
    this.listeners = {};
  }
}
