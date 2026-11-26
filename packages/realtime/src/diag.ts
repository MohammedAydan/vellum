/** Instance id and lifecycle logging for realtime delivery (LISTEN state, stuck or slow drains). Logs one JSON line per call. */
export const RT_INSTANCE_ID = Math.random().toString(36).slice(2, 8);
const STARTED_AT = Date.now();

export function rtLog(event: string, fields: Record<string, unknown>): void {
  try {
    console.warn(JSON.stringify({ rt: event, inst: RT_INSTANCE_ID, up: Date.now() - STARTED_AT, t: Date.now(), ...fields }));
  } catch {
    // diagnostics must never throw
  }
}
