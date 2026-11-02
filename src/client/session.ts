import { parseThreadList } from "../shared/protocol.js";

/**
 * Which threads one Claude session is following. `null` means "all threads".
 * State lives in the MCP process, so two sessions under the same name can follow different threads.
 */
export class Session {
  private followed: Set<string> | null;

  constructor(initial: string[] = []) {
    this.followed = initial.length ? new Set(initial) : null;
  }

  /** Threads to filter on, or null for everything. */
  filter(): string[] | null {
    return this.followed ? [...this.followed] : null;
  }

  /** `[]` means "follow everything". */
  subscribe(threads: string[]): string[] | null {
    const clean = parseThreadList(threads);
    this.followed = clean.length ? new Set(clean) : null;
    return this.filter();
  }

  /** Sending to a thread you don't follow yet adds it, so replies reach you. No-op when following all. */
  noteSend(thread: string): boolean {
    if (!this.followed || this.followed.has(thread)) return false;
    this.followed.add(thread);
    return true;
  }

  follows(thread: string): boolean {
    return !this.followed || this.followed.has(thread);
  }
}
