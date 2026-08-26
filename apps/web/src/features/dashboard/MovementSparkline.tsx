import { useMemo } from 'react';
import type { VolumePoint } from '@invintelx/shared';

interface MovementSparklineProps {
  series: VolumePoint[];
  windowDays: number;
}

interface Bucket {
  label: string;
  quantity: number;
}

/**
 * Weekly buckets rather than ninety daily bars, for the same reason the item
 * demand chart uses them: the question is "busy, quiet, or falling off a
 * cliff", and ninety bars two pixels wide answer it worse than thirteen.
 */
function bucketWeekly(series: VolumePoint[], windowDays: number): Bucket[] {
  const byDay = new Map(series.map((p) => [p.date, p.quantity]));
  const weeks = Math.ceil(windowDays / 7);

  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));

  const buckets: Bucket[] = [];
  for (let w = 0; w < weeks; w += 1) {
    let quantity = 0;
    const from = new Date(start);
    from.setUTCDate(from.getUTCDate() + w * 7);

    for (let d = 0; d < 7; d += 1) {
      const day = new Date(from);
      day.setUTCDate(day.getUTCDate() + d);
      quantity += byDay.get(day.toISOString().slice(0, 10)) ?? 0;
    }
    buckets.push({ label: `week of ${from.toISOString().slice(0, 10)}`, quantity });
  }
  return buckets;
}

/**
 * How much stock has been moving. Context for the lists above it, which is why
 * it carries no axis, no gridlines and no number larger than its caption.
 */
export function MovementSparkline({ series, windowDays }: MovementSparklineProps) {
  const buckets = useMemo(() => bucketWeekly(series, windowDays), [series, windowDays]);
  const peak = Math.max(...buckets.map((b) => b.quantity), 1);
  const total = buckets.reduce((sum, b) => sum + b.quantity, 0);

  if (total === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No stock has moved in the last {windowDays} days.
      </p>
    );
  }

  const width = 100;
  const height = 24;
  const gap = 1.2; // surface gap between bars, in viewBox units
  const barWidth = Math.max(0.8, width / buckets.length - gap);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-12 w-full"
        role="img"
        aria-label={`Units moved weekly over the last ${windowDays} days. Peak week ${peak.toLocaleString()} units, ${total.toLocaleString()} in total.`}
      >
        {buckets.map((bucket, index) => {
          const barHeight = (bucket.quantity / peak) * height;
          return (
            <rect
              key={bucket.label}
              x={index * (barWidth + gap)}
              // Anchored to the baseline, growing upward.
              y={height - barHeight}
              width={barWidth}
              height={barHeight}
              rx={0.6}
              // Deliberately dimmer than the item demand chart. This is context
              // under a list of problems, not the thing being looked at.
              className="fill-chart-1/60"
            >
              <title>{`${bucket.label}: ${bucket.quantity.toLocaleString()} units`}</title>
            </rect>
          );
        })}
      </svg>

      <figcaption className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{windowDays} days ago</span>
        <span className="tabular">{total.toLocaleString()} units moved</span>
        <span>today</span>
      </figcaption>
    </figure>
  );
}
