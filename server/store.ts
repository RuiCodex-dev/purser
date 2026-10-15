import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { PurserEvent } from "./domain/types.ts";

export interface StoreShape {
  events: PurserEvent[];
  seenWebhooks: string[];
  fixtures?: any;
}

/** A small JSON-file store. One process, one writer, atomic replace on save. */
export class Store {
  data: StoreShape = { events: [], seenWebhooks: [] };
  private file?: string;
  private timer?: NodeJS.Timeout;

  constructor(dir?: string) {
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "purser.json");
    if (existsSync(this.file)) {
      try {
        this.data = { events: [], seenWebhooks: [], ...JSON.parse(readFileSync(this.file, "utf8")) };
      } catch {
        // A corrupt file is kept aside rather than overwritten silently.
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      }
    }
  }

  event(id: string): PurserEvent | undefined {
    return this.data.events.find((e) => e.id === id);
  }

  save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 50);
    this.timer.unref?.();
  }

  flush() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }
}

export type BusMessage = { type: string; eventId?: string; [k: string]: unknown };

/** Fan-out for Server-Sent Events. */
export class Bus {
  private subs = new Set<(m: BusMessage) => void>();
  on(fn: (m: BusMessage) => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  emit(m: BusMessage) {
    for (const fn of this.subs) fn(m);
  }
}
