

export function ReadOnlyMetric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-2.5">
      <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
      <p className={`mt-1 truncate text-xs font-medium text-foreground ${mono ? "font-mono" : ""}`} title={value}>{value}</p>
    </div>
  );
}
