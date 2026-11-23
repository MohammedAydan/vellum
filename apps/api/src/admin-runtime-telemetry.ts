/** Process-local observations, never inferred from architecture or defaults. */
export const adminRuntimeTelemetry: {
  maintenanceIntervalMs: number | null;
  realtimeChannel: string | null;
  realtimeConnected: boolean | null;
} = { maintenanceIntervalMs: null, realtimeChannel: null, realtimeConnected: null };
