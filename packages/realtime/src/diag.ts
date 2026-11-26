/** Instance id and opt-in diagnostics for realtime delivery. Logs one JSON line per call. */
export const RT_INSTANCE_ID = Math.random().toString(36).slice(2, 8);
const STARTED_AT = Date.now();

/** True when per-event diagnostics are enabled for this project (env VELLUM_RT_DIAG_PROJECT, `*` = all). */
export function rtDiagEnabled(projectId: string): boolean {
  const want = process.env["VELLUM_RT_DIAG_PROJECT"];
  return want !== undefined && want !== "" && (want === "*" || want === projectId);
}

export function rtLog(event: string, fields: Record<string, unknown>): void {
  try {
    console.warn(JSON.stringify({ rt: event, inst: RT_INSTANCE_ID, up: Date.now() - STARTED_AT, t: Date.now(), ...fields }));
  } catch {
    // diagnostics must never throw
  }
}
