/**
 * Bounded CPU profiler for the idle diagnostic.
 *
 * It wraps `node:inspector`'s `Profiler`, which Bun exposes from 1.3.7 onward, so a caller can
 * start sampling right before the measured idle window and stop right after it: the profile covers
 * exactly the window of interest, not the whole process life. The module is imported through a
 * string specifier so a host build that trims `node:inspector` degrades to an explicit
 * "unavailable" at runtime instead of breaking type-check at build time. No private host API is
 * used and garbage collection is never forced.
 */

export interface CpuProfileFrame {
  readonly functionName: string;
  readonly url: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}

export interface CpuProfileNode {
  readonly id: number;
  readonly callFrame: CpuProfileFrame;
  readonly hitCount?: number;
  readonly children?: readonly number[];
}

/** The Chrome DevTools CPU-profile shape returned by `Profiler.stop`. */
export interface CpuProfile {
  readonly nodes: readonly CpuProfileNode[];
  readonly startTime: number;
  readonly endTime: number;
  readonly samples?: readonly number[];
  readonly timeDeltas?: readonly number[];
}

export interface CpuProfiler {
  stop(): Promise<CpuProfile>;
}

export interface CpuProfileSupport {
  readonly available: boolean;
  readonly reason?: string;
}

/** Report whether the host embeds a usable `node:inspector` Profiler, without starting one. */
export async function cpuProfileSupport(): Promise<CpuProfileSupport> {
  try {
    const inspector: any = await import("node:inspector" as string);
    if (typeof inspector?.Session !== "function") {
      return { available: false, reason: "node:inspector.Session is not a function" };
    }
    return { available: true };
  } catch (error) {
    return { available: false, reason: String(error) };
  }
}

/**
 * Start a sampling CPU profile on the current isolate. Throws when the embedding lacks a usable
 * Profiler; callers record the failure and keep the CPU-time measurement instead of aborting.
 */
export async function startCpuProfile(samplingIntervalUs = 1000): Promise<CpuProfiler> {
  const inspector: any = await import("node:inspector" as string);
  const Session = inspector?.Session;
  if (typeof Session !== "function") throw new Error("node:inspector.Session is not a function");
  const session = new Session();
  if (typeof session.connect !== "function" || typeof session.post !== "function") {
    throw new Error("node:inspector session is incomplete");
  }
  const post = (method: string, params?: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      session.post(method, params, (error: any, result: any) => {
        if (error) reject(new Error(String(error)));
        else resolve(result);
      });
    });
  session.connect();
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: samplingIntervalUs });
  await post("Profiler.start");
  let stopped = false;
  return {
    async stop() {
      if (stopped) throw new Error("profile already stopped");
      stopped = true;
      try {
        const result = await post("Profiler.stop");
        return result.profile as CpuProfile;
      } finally {
        session.disconnect();
      }
    },
  };
}
