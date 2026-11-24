import * as React from "react";
import { useI18n } from "@vellum/ui";

export interface MapRule {
  collection: string;
  field: string;
  targetCollection: string;
  onDelete: "cascade" | "set_null" | "restrict";
}

const W = 720;
const NODE_W = 120;
const NODE_H = 30;

export interface MapNode {
  name: string;
  x: number;
  y: number;
}

/** Place collections on an ellipse so edges stay readable up to the 50-rule cap. */
export function layoutNodes(names: string[], height: number): MapNode[] {
  if (names.length === 1) return [{ name: names[0]!, x: W / 2, y: height / 2 }];
  const rx = Math.min(W / 2 - NODE_W / 2 - 12, 120 + names.length * 28);
  const ry = height / 2 - NODE_H - 8;
  return names.map((name, i) => {
    const angle = (2 * Math.PI * i) / names.length - Math.PI / 2;
    return { name, x: W / 2 + rx * Math.cos(angle), y: height / 2 + ry * Math.sin(angle) };
  });
}

export function mapCollections(rules: readonly MapRule[]): string[] {
  const set = new Set<string>();
  for (const r of rules) {
    if (r.collection.trim()) set.add(r.collection.trim());
    if (r.targetCollection.trim()) set.add(r.targetCollection.trim());
  }
  return [...set].sort();
}

function edgePath(from: MapNode, to: MapNode, index: number): { d: string; lx: number; ly: number } {
  if (from.name === to.name) {
    const x = from.x + NODE_W / 2;
    const y = from.y;
    return { d: `M ${x} ${y - 6} C ${x + 46} ${y - 40}, ${x + 46} ${y + 40}, ${x} ${y + 6}`, lx: x + 40, ly: y };
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Stop at the node border (rectangle approximated by an ellipse).
  const trim = (n: number): number => Math.min(NODE_W / 2 / Math.max(Math.abs(ux), 0.01), NODE_H / 2 / Math.max(Math.abs(uy), 0.01), n);
  const t = trim(len / 2) + 3;
  const sx = from.x + ux * t;
  const sy = from.y + uy * t;
  const ex = to.x - ux * (t + 4);
  const ey = to.y - uy * (t + 4);
  const bend = 18 + (index % 3) * 8;
  const mx = (sx + ex) / 2 - uy * bend;
  const my = (sy + ey) / 2 + ux * bend;
  return { d: `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`, lx: (sx + ex) / 2 - uy * bend * 0.5, ly: (sy + ey) / 2 + ux * bend * 0.5 };
}

const DASH: Record<MapRule["onDelete"], string | undefined> = {
  cascade: undefined,
  set_null: "5 4",
  restrict: "1.5 3.5",
};

export interface RelationMapProps {
  rules: readonly MapRule[];
  /** Called after two collections were picked: referencing (child) then referenced (target). */
  onConnect: (collection: string, target: string) => void;
  onSelectRule?: (index: number) => void;
}

export function RelationMap({ rules, onConnect }: RelationMapProps): React.ReactElement | null {
  const { t } = useI18n();
  const [source, setSource] = React.useState<string | null>(null);
  const names = React.useMemo(() => mapCollections(rules), [rules]);
  if (names.length === 0) return null;
  const height = names.length <= 3 ? 220 : 340;
  const nodes = layoutNodes(names, height);
  const byName = new Map(nodes.map((n) => [n.name, n]));

  const pick = (name: string): void => {
    if (source === null) {
      setSource(name);
      return;
    }
    const from = source;
    setSource(null);
    onConnect(from, name);
  };

  return (
    <div className="rounded-md border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <p className="text-xs text-muted-foreground">
          {source === null ? t("relations.map.hint") : t("relations.map.pickTarget", { source })}
        </p>
        <ul className="flex items-center gap-3 text-[11px] text-muted-foreground" aria-label={t("relations.map.legend")}>
          {(["cascade", "set_null", "restrict"] as const).map((kind) => (
            <li key={kind} className="flex items-center gap-1.5 font-mono">
              <svg width="22" height="6" aria-hidden="true">
                <line x1="0" y1="3" x2="22" y2="3" stroke="currentColor" strokeWidth="1.5" strokeDasharray={DASH[kind]} className={kind === "cascade" ? "text-primary" : undefined} />
              </svg>
              {kind}
            </li>
          ))}
        </ul>
      </div>
      <svg viewBox={`0 0 ${W} ${height}`} className="h-auto w-full" role="img" aria-label={t("relations.map.title")}>
        <defs>
          <marker id="rel-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
          </marker>
        </defs>
        {rules.map((rule, i) => {
          const from = byName.get(rule.collection.trim());
          const to = byName.get(rule.targetCollection.trim());
          if (!from || !to) return null;
          const { d, lx, ly } = edgePath(from, to, i);
          return (
            <g key={`${rule.collection}.${rule.field}.${i}`} className={rule.onDelete === "cascade" ? "text-primary" : "text-muted-foreground"}>
              <path d={d} fill="none" stroke="currentColor" strokeWidth={rule.onDelete === "cascade" ? 1.6 : 1.2} strokeDasharray={DASH[rule.onDelete]} markerEnd="url(#rel-arrow)" />
              <text x={lx} y={ly} textAnchor="middle" className="fill-muted-foreground font-mono" fontSize="10" paintOrder="stroke" stroke="var(--card, transparent)" strokeWidth="3">
                {rule.field}
              </text>
            </g>
          );
        })}
        {nodes.map((n) => {
          const active = source === n.name;
          return (
            <g
              key={n.name}
              role="button"
              tabIndex={0}
              aria-pressed={active}
              aria-label={n.name}
              className="cursor-pointer outline-none"
              onClick={() => pick(n.name)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pick(n.name);
                }
              }}
            >
              <rect
                x={n.x - NODE_W / 2}
                y={n.y - NODE_H / 2}
                width={NODE_W}
                height={NODE_H}
                rx="6"
                className={active ? "fill-primary/10 stroke-primary" : "fill-muted stroke-border hover:stroke-primary"}
                strokeWidth="1"
              />
              <text x={n.x} y={n.y + 4} textAnchor="middle" className="fill-foreground font-mono" fontSize="12">
                {n.name.length > 16 ? `${n.name.slice(0, 15)}…` : n.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
