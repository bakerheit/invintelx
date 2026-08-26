import { useState } from 'react';
import { Link } from 'react-router';
import { ChevronDown, ChevronRight, PackageSearch } from 'lucide-react';
import { formatCents, type ReorderSuggestion } from '@invintelx/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useActionList } from './api';

/** One decimal is as much precision as a demand estimate deserves. */
function formatDays(days: number | null): string {
  if (days === null) return 'no demand';
  if (days < 1) return 'under a day';
  return `${days.toFixed(1)} days`;
}

function coverTone(days: number | null): string {
  if (days === null) return 'text-muted-foreground';
  if (days <= 3) return 'text-destructive';
  if (days <= 10) return 'text-warning';
  return 'text-foreground';
}

export function DashboardPage() {
  const query = useActionList();
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">What to act on today</h1>
        <p className="text-sm text-muted-foreground">
          SKUs at or below their reorder point, worst first. Ranked by how soon they run out.
        </p>
      </div>

      {query.isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {query.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
          <p className="font-medium text-destructive">Could not build the action list</p>
          <p className="mt-1 text-sm text-muted-foreground">{query.error.message}</p>
        </div>
      )}

      {query.data && query.data.items.length === 0 && (
        <div className="rounded-lg border border-border bg-card p-12 text-center">
          <PackageSearch className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 font-medium">Nothing needs reordering</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {query.data.itemsConsidered === 0
              ? 'There are no active items yet.'
              : `Checked ${query.data.itemsConsidered} active ${query.data.itemsConsidered === 1 ? 'SKU' : 'SKUs'}. None is at its reorder point.`}
          </p>
        </div>
      )}

      {query.data && query.data.items.length > 0 && (
        <>
          <ul className="space-y-2">
            {query.data.items.map((suggestion) => (
              <ActionRow
                key={suggestion.itemId}
                suggestion={suggestion}
                isExpanded={expanded === suggestion.itemId}
                onToggle={() =>
                  setExpanded((prev) => (prev === suggestion.itemId ? null : suggestion.itemId))
                }
              />
            ))}
          </ul>

          <p className="text-xs text-muted-foreground">
            {query.data.items.length} of {query.data.itemsConsidered} active SKUs need attention.
            Demand measured over {query.data.windowDays} days, assuming a {query.data.leadTimeDays}
            -day lead time at {query.data.serviceLevel}% service level.
          </p>
        </>
      )}
    </div>
  );
}

function ActionRow({
  suggestion,
  isExpanded,
  onToggle,
}: {
  suggestion: ReorderSuggestion;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isExpanded}
          aria-label={`Show the working for ${suggestion.sku}`}
          className="text-muted-foreground hover:text-foreground"
        >
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        <div className="min-w-[160px] flex-1">
          <p className="font-medium tabular">{suggestion.sku}</p>
          <p className="truncate text-sm text-muted-foreground">{suggestion.name}</p>
        </div>

        <div className="text-sm">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">On hand</p>
          <p className="tabular">
            {suggestion.onHand.toLocaleString()}{' '}
            <span className="text-xs text-muted-foreground">{suggestion.unitOfMeasure}</span>
          </p>
        </div>

        <div className="text-sm">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Cover</p>
          <p className={cn('tabular font-medium', coverTone(suggestion.daysOfCover))}>
            {formatDays(suggestion.daysOfCover)}
          </p>
        </div>

        <div className="text-sm">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Order</p>
          <p className="tabular font-medium">
            {suggestion.suggestedOrderQuantity.toLocaleString()}
          </p>
        </div>

        <Button asChild variant="outline" size="sm">
          {/* Until purchase orders exist, the action is to go look at the item. */}
          <Link to={`/items?q=${encodeURIComponent(suggestion.sku)}`}>Open</Link>
        </Button>
      </div>

      {isExpanded && (
        <div className="border-t border-border bg-muted/30 px-4 py-3 text-sm">
          <p className="mb-2 font-medium">How this was worked out</p>
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <Working label="Average daily demand" value={`${suggestion.averageDailyDemand.toFixed(2)} ${suggestion.unitOfMeasure}/day`} />
            <Working label="Demand variability (σ)" value={suggestion.demandStdDev.toFixed(2)} />
            <Working
              label={`Demand over ${suggestion.leadTimeDays} days lead time`}
              value={suggestion.demandDuringLeadTime.toFixed(1)}
            />
            <Working
              label={`Safety stock at ${suggestion.serviceLevel}%`}
              value={suggestion.safetyStock.toFixed(1)}
            />
            <Working
              label="Suggested reorder point"
              value={`${suggestion.suggestedReorderPoint.toLocaleString()} (currently ${suggestion.currentReorderPoint.toLocaleString()})`}
            />
            <Working label="Value on hand" value={formatCents(suggestion.valueOnHandCents)} />
            <Working
              label="Demand value per day"
              value={formatCents(suggestion.dailyDemandValueCents)}
            />
          </dl>

          {suggestion.suggestedReorderPoint !== suggestion.currentReorderPoint && (
            <Badge variant="warning" className="mt-3">
              Configured reorder point looks{' '}
              {suggestion.suggestedReorderPoint > suggestion.currentReorderPoint ? 'too low' : 'too high'}
            </Badge>
          )}
        </div>
      )}
    </li>
  );
}

function Working({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border/50 py-1 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
