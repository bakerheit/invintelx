import { varianceHeadline, type CountSheetSummary } from '@invintelx/shared';
import { cn } from '@/lib/utils';
import { accuracyLabel } from './varianceView';

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'short' | 'over' | 'muted';
}) {
  return (
    <div className="min-w-0">
      <p
        className={cn(
          'tabular text-2xl font-semibold',
          tone === 'short' && 'text-destructive',
          tone === 'over' && 'text-warning',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * The top of the variance report, sized for somebody holding a tablet in an
 * aisle rather than reading a spreadsheet.
 *
 * Net and absolute variance are both shown, and absolute is the one in large
 * type. A bin five over on one SKU and five short on another nets to zero and
 * is ten units wrong; leading with the net would report that as a clean count.
 */
export function VarianceSummary({ summary }: { summary: CountSheetSummary }) {
  return (
    <section
      aria-label="Variance summary"
      className="rounded-lg border border-border bg-card p-4 sm:p-6"
    >
      <p className="text-lg font-medium">{varianceHeadline(summary)}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">
        {summary.countedCount.toLocaleString()} of {summary.lineCount.toLocaleString()} lines
        counted
        {summary.uncountedCount > 0
          ? ` · ${summary.uncountedCount.toLocaleString()} still to walk`
          : ''}
      </p>

      <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Figure label="Lines short" value={summary.shortCount.toLocaleString()} tone="short" />
        <Figure label="Lines over" value={summary.overCount.toLocaleString()} tone="over" />
        <Figure label="Units out" value={summary.absVariance.toLocaleString()} />
        <Figure
          label="Net units"
          value={`${summary.netVariance > 0 ? '+' : ''}${summary.netVariance.toLocaleString()}`}
          tone="muted"
        />
        <Figure label="Lines agreeing" value={accuracyLabel(summary.accuracy)} />
      </div>
    </section>
  );
}
