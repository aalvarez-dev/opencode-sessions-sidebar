import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

type HealthHost = {
  readonly client: { readonly global: Pick<TuiPluginApi["client"]["global"], "health"> };
  readonly lifecycle: Pick<TuiPluginApi["lifecycle"], "signal">;
};
type Schedule = (callback: () => void, delayMs: number) => () => void;
const scheduleTimeout: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

/**
 * The pinned TUI API has no transport-loss event. Its local RPC fetch also buffers
 * response.text(), so opening an extra SSE stream would hang that transport.
 * One public health request every five seconds is the bounded TUI-only fallback.
 * Healthy responses cause no adapter/UI work; no session metadata is polled.
 */
export function monitorV1Transport(
  host: HealthHost,
  availability: (available: boolean) => void,
  schedule: Schedule = scheduleTimeout,
): () => void {
  let disposed = false;
  let unavailable = false;
  let pending: AbortController | undefined;
  let cancelNext: (() => void) | undefined;
  let cancelTimeout: (() => void) | undefined;

  function lost() {
    if (disposed) return;
    unavailable = true;
    // The native event bus can recover the adapter between probes. Report each
    // failed attempt so another cut is not hidden by this monitor's old state;
    // the adapter itself suppresses unchanged availability notifications.
    availability(false);
  }

  function next() {
    if (disposed) return;
    cancelNext = schedule(() => {
      cancelNext = undefined;
      void probe();
    }, 5_000);
  }

  async function probe() {
    if (disposed || pending) return;
    const controller = new AbortController();
    pending = controller;
    let expired = false;
    let fulfilled = false;
    cancelTimeout = schedule(() => {
      cancelTimeout = undefined;
      expired = true;
      lost();
      controller.abort();
    }, 2_000);
    try {
      // Read the live client getter on each attempt, preserving host auth/fetch.
      const response = await host.client.global.health({
        signal: controller.signal,
        throwOnError: true,
      });
      fulfilled = true;
      if (disposed || expired) return;
      if (response.data?.healthy !== true) {
        lost();
      } else if (unavailable) {
        unavailable = false;
        availability(true);
      }
    } catch {
      if (!expired) lost();
    } finally {
      cancelTimeout?.();
      cancelTimeout = undefined;
      if (!fulfilled) controller.abort();
      pending = undefined;
      // Do not accumulate requests if a non-cooperative host ignores abort. The
      // timeout marks uncertainty immediately, but retry waits for settlement.
      next();
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelNext?.();
    cancelNext = undefined;
    cancelTimeout?.();
    cancelTimeout = undefined;
    pending?.abort();
    host.lifecycle.signal.removeEventListener("abort", dispose);
  }

  host.lifecycle.signal.addEventListener("abort", dispose, { once: true });
  if (host.lifecycle.signal.aborted) dispose();
  else next();
  return dispose;
}
