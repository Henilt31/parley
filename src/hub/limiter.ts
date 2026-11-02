/** Sliding-window limiter: at most `limit` events per `windowMs` for each key. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Records one event. Returns 0 if allowed, otherwise the milliseconds until a slot frees up. */
  hit(key: string): number {
    const list = this.prune(key);
    if (list.length >= this.limit) return Math.max(1, list[0]! + this.windowMs - this.now());
    list.push(this.now());
    this.hits.set(key, list);
    return 0;
  }

  /** Records an event without checking the limit (used for failed-auth tracking). */
  record(key: string): void {
    const list = this.prune(key);
    list.push(this.now());
    this.hits.set(key, list);
  }

  /** Returns 0 if the key is under the limit, otherwise ms until it is again. Does not record. */
  blockedFor(key: string): number {
    const list = this.prune(key);
    if (list.length < this.limit) return 0;
    return Math.max(1, list[0]! + this.windowMs - this.now());
  }

  sweep(): void {
    for (const key of [...this.hits.keys()]) this.prune(key);
  }
}
