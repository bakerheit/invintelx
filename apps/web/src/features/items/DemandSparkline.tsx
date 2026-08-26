import { useMemo } from 'react';
import type { DemandPoint } from '@invintelx/shared';

interface DemandSparklineProps {
  series: DemandPoint[];
  windowDays: number;
  unitOfMeasure: string;
}

interface Bucket {
  label: string;
  quantity: number;
}

/**
 * Weekly buckets rather than ninety daily bars.
 *
 * The question this answers is "steady, spiky, or dying" — ninety bars a couple
 * of pixels wide answer it worse than thirteen that can carry a gap and a hover
 * target. The lumpiness that gets averaged away is already reported numerically
 * as the standard deviation beside it.
 */
function bucketWeekly(series: DemandPoint[], windowDays: number): Bucket[] {
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

export function DemandSparkline({ series, windowDays, unitOfMeasure }: DemandSparklineProps) {
  const buckets = useMemo(() => bucketWeekly(series, windowDays), [series, windowDays]);
  const peak = Math.max(...buckets.map((b) => b.quantity), 1);
  const total = buckets.reduce((sum, b) => sum + b.quantity, 0);

  if (total === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing issued in the last {windowDays} days, so there is no demand to plot.
      </p>
    );
  }

  const width = 100;
  const height = 28;
  const gap = 1.2; // surface gap between bars, in viewBox units
  const barWidth = Math.max(0.8, width / buckets.length - gap);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-16 w-full"
        role="img"
        aria-label={`Weekly demand over the last ${windowDays} days. Peak week ${peak} ${unitOfMeasure}, ${total} in total.`}
      >
        {buckets.map((bucket, index) => {
          const barHeight = (bucket.quantity / peak) * height;
          const x = index * (barWidth + gap);
          return (
            <rect
              key={bucket.label}
              x={x}
              // Anchored to the baseline, growing upward.
              y={height - barHeight}
              width={barWidth}
              height={barHeight}
              rx={0.6}
              className="fill-chart-1"
            >
              <title>{`${bucket.label}: ${bucket.quantity} ${unitOfMeasure}`}</title>
            </rect>
          );
        })}
      </svg>

      <figcaption className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{windowDays} days ago</span>
        <span className="tabular">
          peak {peak.toLocaleString()} {unitOfMeasure}/week
        </span>
        <span>today</span>
      </figcaption>
    </figure>
  );
}
