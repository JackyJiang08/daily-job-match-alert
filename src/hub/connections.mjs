// Read-only connection probe for the Settings page: asks each subscription CLI whether it is installed
// and signed in, caches the answer for 60 seconds, and never signs in on the owner's behalf.
import { describeConnections } from '../engines/index.mjs';

export const CONNECTIONS_TTL_MS = 60_000;

export function createConnectionsProbe(options = {}) {
  const now = options.now || (() => new Date());
  const ttl = Number(options.ttlMs || CONNECTIONS_TTL_MS);
  const describe = options.describe || (() => describeConnections({ runner: options.runner }));
  let cached = null;
  let pending = null;

  async function status({ force = false } = {}) {
    const at = now().getTime();
    if (!force && cached && at - cached.at < ttl) return cached.value;
    if (!pending) {
      pending = describe()
        .then(value => {
          cached = { at: now().getTime(), value: { ...value, checkedAt: new Date(now().getTime()).toISOString() } };
          return cached.value;
        })
        .finally(() => { pending = null; });
    }
    return pending;
  }

  return { status, reset: () => { cached = null; } };
}
