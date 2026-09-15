"use client";

import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import { SERIES, shortDay } from "./chart";
import { formatScore } from "./ScoreChip";

/**
 * Score shape for one (agent, evaluator) pair — a single 1.5px line, no axes, no
 * chartjunk. The number itself is always shown by the chip beside it, so the
 * spark never gates a value; the native title carries the daily readout.
 */
export default function Sparkline({
  points,
  label,
  testId,
}: {
  points: { day: string; avg: number }[];
  label?: string;
  testId?: string;
}) {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const title = [
    label,
    `${shortDay(first.day)} ${formatScore(first.avg)} → ${shortDay(last.day)} ${formatScore(last.avg)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div data-testid={testId} title={title} className="h-[22px] w-full mx-auto max-w-[108px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 3, right: 2, bottom: 2, left: 2 }}>
          <YAxis hide domain={[0, 1]} />
          <Line
            type="monotone"
            dataKey="avg"
            stroke={SERIES}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
