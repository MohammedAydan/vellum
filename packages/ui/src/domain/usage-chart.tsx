import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "../components/card.js";
import { cn } from "../lib/cn.js";

export interface UsageMetricPoint {
  timestamp: string;
  reads?: number;
  writes?: number;
  storageMb?: number;
  connections?: number;
  [key: string]: string | number | undefined;
}

export interface UsageChartProps {
  title?: string;
  data: UsageMetricPoint[];
  type?: "area" | "line" | "bar";
  metrics?: {
    key: string;
    label: string;
    color?: string;
  }[];
  height?: number;
  className?: string;
}

export function UsageChart({
  title,
  data,
  type = "area",
  metrics = [
    { key: "reads", label: "Read Ops", color: "var(--color-chart-1)" },
    { key: "writes", label: "Write Ops", color: "var(--color-chart-2)" },
  ],
  height = 240,
  className,
}: UsageChartProps) {
  const renderChart = () => {
    switch (type) {
      case "bar":
        return (
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="timestamp" tickLine={false} />
            <YAxis tickLine={false} axisLine={false} />
            <Tooltip />
            {metrics.map((m) => (
              <Bar
                key={m.key}
                dataKey={m.key}
                name={m.label}
                fill={m.color ?? "var(--color-chart-1)"}
                radius={[4, 4, 0, 0]}
              />
            ))}
          </BarChart>
        );
      case "line":
        return (
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="timestamp" tickLine={false} />
            <YAxis tickLine={false} axisLine={false} />
            <Tooltip />
            {metrics.map((m) => (
              <Line
                key={m.key}
                type="monotone"
                dataKey={m.key}
                name={m.label}
                stroke={m.color ?? "var(--color-chart-1)"}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        );
      case "area":
      default:
        return (
          <AreaChart data={data}>
            <defs>
              {metrics.map((m, idx) => (
                <linearGradient
                  key={m.key}
                  id={`gradient-${m.key}-${idx}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="5%"
                    stopColor={m.color ?? "var(--color-chart-1)"}
                    stopOpacity={0.3}
                  />
                  <stop
                    offset="95%"
                    stopColor={m.color ?? "var(--color-chart-1)"}
                    stopOpacity={0}
                  />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="timestamp" tickLine={false} />
            <YAxis tickLine={false} axisLine={false} />
            <Tooltip />
            {metrics.map((m, idx) => (
              <Area
                key={m.key}
                type="monotone"
                dataKey={m.key}
                name={m.label}
                stroke={m.color ?? "var(--color-chart-1)"}
                fillOpacity={1}
                fill={`url(#gradient-${m.key}-${idx})`}
                strokeWidth={2}
              />
            ))}
          </AreaChart>
        );
    }
  };

  return (
    <Card className={cn("border-border bg-surface", className)}>
      {title ? (
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent className="p-4 pt-2">
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            {renderChart()}
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
