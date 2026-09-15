"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AXIS_TEXT, GOOD_BAND, GRID, SERIES, TOOLTIP_STYLE, WARN_BAND, shortDay } from "./chart";
import ScoreChip, { formatScore } from "./ScoreChip";
import type { EvaluatorSeries } from "./types";

/**
 * Score over time, one small-multiple facet per evaluator. Single series per
 * plot, so the facet title is the identity and no legend is needed; the latest
 * value rides the facet header as the one direct label, and the sessions table
 * below is the table view for every other number.
 */
export default function TrendChart({
  series,
  evaluatorOrder,
  loading,
}: {
  series: EvaluatorSeries;
  /** Preferred display order; anything else follows alphabetically. */
  evaluatorOrder?: string[];
  loading?: boolean;
}) {
  const names = Object.keys(series)
    .filter((name) => series[name].length > 0)
    .sort((a, b) => {
      const ia = evaluatorOrder?.indexOf(a) ?? -1;
      const ib = evaluatorOrder?.indexOf(b) ?? -1;
      if (ia !== ib) return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
      return a.localeCompare(b);
    });

  if (!names.length) {
    return (
      <div
        data-testid="eval-trend-empty"
        className="bg-surface-2 border border-surface-4 rounded-xl px-4 py-8 text-center text-xs text-[var(--color-text-muted)]"
      >
        {loading ? "Loading score history…" : "No scored days in this window."}
      </div>
    );
  }

  return (
    <div data-testid="eval-trend-chart" className="space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {names.map((name) => {
          const points = series[name];
          const last = points[points.length - 1];
          return (
            <div
              key={name}
              data-testid={`eval-trend-${name}`}
              className="bg-surface-2 border border-surface-4 rounded-xl p-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-[var(--color-text-secondary)] truncate" title={name}>
                  {name}
                </span>
                <ScoreChip score={last.avg} title={`Latest — ${shortDay(last.day)}`} />
              </div>
              <div className="h-[104px] mt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
                    <XAxis
                      dataKey="day"
                      tickFormatter={shortDay}
                      tick={{ fontSize: 10, fill: AXIS_TEXT }}
                      tickLine={false}
                      axisLine={{ stroke: GRID }}
                      minTickGap={24}
                    />
                    <YAxis
                      domain={[0, 1]}
                      ticks={[0, 0.5, 1]}
                      tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
                      tick={{ fontSize: 10, fill: AXIS_TEXT }}
                      tickLine={false}
                      axisLine={false}
                      width={44}
                    />
                    <ReferenceLine y={0.9} stroke={GOOD_BAND} strokeOpacity={0.35} strokeWidth={1} />
                    <ReferenceLine y={0.75} stroke={WARN_BAND} strokeOpacity={0.35} strokeWidth={1} />
                    <Line
                      type="monotone"
                      dataKey="avg"
                      stroke={SERIES}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      dot={points.length === 1 ? { r: 4, fill: SERIES, stroke: "var(--color-surface-2)", strokeWidth: 2 } : false}
                      activeDot={{ r: 4, fill: SERIES, stroke: "var(--color-surface-2)", strokeWidth: 2 }}
                      isAnimationActive={false}
                    />
                    <Tooltip
                      cursor={{ stroke: GRID, strokeWidth: 1 }}
                      contentStyle={TOOLTIP_STYLE}
                      labelFormatter={(day: string) => shortDay(day)}
                      formatter={(value: number, _key, payload) => [
                        `${formatScore(value)} · ${(payload?.payload as { count?: number })?.count ?? 0} scored`,
                        name,
                      ]}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-[var(--color-text-muted)]">
        Daily average per evaluator. Band lines mark the 90% (good) and 75% (warn) thresholds.
      </p>
    </div>
  );
}
