import type { Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';

// Fetch the store's products, download their photos, build the brief and store it.
// With opts.print, write the brief JSON to stdout.
export async function runIngest(_db: Db, _config: Config, _now: Date, _opts: { print: boolean }): Promise<void> {
  throw new Error('ingest: not implemented yet');
}
