/** Passive lifecycle-only counters. Never used in resource acceptance or long idle. */
import product from "CANDIDATE_PRODUCT_URL";
import { writeFileSync, renameSync } from "node:fs";
const totals = {
  activations: 0,
  disposals: 0,
  liveEventListeners: 0,
  pendingHealth: 0,
  healthCalls: 0,
  healthFailures: 0,
  healthCallsAfterDisposal: 0,
  deliveredAfterDisposal: 0,
};
function publish() {
  const path = process.env.SIDEBAR_LIFECYCLE_COUNTERS;
  if (!path) throw new Error("Missing lifecycle counter destination");
  writeFileSync(path + ".tmp", JSON.stringify(totals));
  renameSync(path + ".tmp", path);
}
const forward = (read, overrides) =>
  new Proxy(Object.create(null), {
    get(_target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const source = read();
      const value = Reflect.get(source, key, source);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
export default {
  ...product,
  async tui(api, options) {
    let disposed = false;
    totals.activations++;
    api.lifecycle.onDispose(() => {
      disposed = true;
      totals.disposals++;
      publish();
    });
    const event = forward(() => api.event, {
      on(type, listener) {
        totals.liveEventListeners++;
        const remove = api.event.on(type, (...args) => {
          if (disposed) {
            totals.deliveredAfterDisposal++;
            publish();
          }
          return listener(...args);
        });
        let removed = false;
        return () => {
          if (removed) return;
          removed = true;
          totals.liveEventListeners--;
          try {
            return remove();
          } finally {
            publish();
          }
        };
      },
    });
    const global = forward(() => api.client.global, {
      async health(...args) {
        totals.healthCalls++;
        totals.pendingHealth++;
        if (disposed) totals.healthCallsAfterDisposal++;
        publish();
        try {
          const live = api.client.global;
          return await Reflect.apply(live.health, live, args);
        } catch (error) {
          totals.healthFailures++;
          throw error;
        } finally {
          totals.pendingHealth--;
          publish();
        }
      },
    });
    const client = forward(() => api.client, { global });
    publish();
    return Reflect.apply(product.tui, product, [forward(() => api, { event, client }), options]);
  },
};
