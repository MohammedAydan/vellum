export interface ImportRow { id?: string; data: Record<string, unknown> }

/** Accept dashboard exports as well as the documented bare-row array. */
export function parseDashboardImport(input: unknown): ImportRow[] {
  const rows = input && typeof input === "object" && !Array.isArray(input) && "documents" in input
    ? input.documents : input;
  if (!Array.isArray(rows)) throw new Error("Expected a document array or export envelope");
  return rows.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("data" in entry)
      || !entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)
      || ("id" in entry && typeof entry.id !== "string")) {
      throw new Error("Each import row must contain object data and an optional string ID");
    }
    return { ...("id" in entry ? { id: entry.id as string } : {}), data: entry.data as Record<string, unknown> };
  });
}

/** Keep each transport request bounded, including the API's aggregate key guard. */
export function batchDashboardImport(rows: ImportRow[]): ImportRow[][] {
  const batches: ImportRow[][] = [];
  let batch: ImportRow[] = [];
  let keys = 0;
  const countKeys = (value: unknown): number => {
    if (!value || typeof value !== "object") return 0;
    if (Array.isArray(value)) return value.reduce((n, item) => n + countKeys(item), 0);
    return Object.entries(value).reduce((n, [, item]) => n + 1 + countKeys(item), 0);
  };
  for (const row of rows) {
    const size = countKeys(row);
    if (batch.length && (batch.length >= 20 || keys + size > 450)) { batches.push(batch); batch = []; keys = 0; }
    batch.push(row); keys += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
