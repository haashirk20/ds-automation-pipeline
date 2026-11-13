import type { Config } from '../config/index.ts';
import { abortableSleep, makeBridgePublisher, type BridgeDeps } from './bridge.ts';
import type { Publisher } from './types.ts';

// Every platform publishes through the bridge. `now` comes from cli.ts; tests pass a fake fetch.
export function makePublishers(config: Config, deps: Pick<BridgeDeps, 'now'> & Partial<BridgeDeps>): Record<string, Publisher> {
  const d: BridgeDeps = { fetch, sleep: abortableSleep, ...deps };
  return Object.fromEntries(Object.entries(config.platforms).map(([name, c]) => [name, makeBridgePublisher(name, c, d)]));
}
