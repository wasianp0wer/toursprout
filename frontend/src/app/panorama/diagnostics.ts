/**
 * Opt-in renderer tracing, enabled with ?diag=1.
 *
 * The rephoto renderer runs inside a WebGL context that cannot be inspected
 * from the build environment, so its boundaries report themselves instead:
 * whether it was added, what reference frame it got, where the planes landed,
 * and where the camera thinks it is.
 */
export function diagnosticsEnabled(search: string): boolean {
  return new URLSearchParams(search).get('diag') === '1';
}

export interface Diagnostics {
  log(label: string, detail?: unknown): void;
  once(label: string, detail?: unknown): void;
}

export function createDiagnostics(enabled: boolean): Diagnostics {
  if (!enabled) {
    return { log: () => undefined, once: () => undefined };
  }
  const seen = new Set<string>();
  return {
    log(label, detail) {
      // Stringify rather than pass the object: console readers collapse
      // objects to "Object", which hides exactly the numbers being traced.
      console.log(`[rephoto] ${label} ${detail === undefined ? '' : JSON.stringify(detail)}`);
    },
    once(label, detail) {
      if (seen.has(label)) return;
      seen.add(label);
      console.log(`[rephoto] ${label} ${detail === undefined ? '' : JSON.stringify(detail)}`);
    },
  };
}
