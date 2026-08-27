import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  PackageSearch,
  Snowflake,
  TrendingDown,
  Truck,
} from 'lucide-react';
import { formatCents, type DeadStockRow, type ReorderSuggestion } from '@invintelx/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { FirstRunHint } from '@/features/onboarding/FirstRunHint';
import { cn } from '@/lib/utils';
import { MovementSparkline } from './MovementSparkline';
import { useDashboard } from './api';

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

/**
 * The landing screen.
 *
 * Ordered by how much it hurts, not by the order the sections were specified:
 * a SKU that is already out is costing money now, one below its reorder point
 * is about to, and dead stock has been costing money quietly for months. A
 * reader who only gets through the first section has still read the worst news.
 *
 * Each list is a shortlist with its full count beside it, because a screen that
 * shows five stockouts and a business that has five stockouts must not look the
 * same.
 */
export function DashboardPage() {
  const query = useDashboard();
  const data = query.data;

  const nothingToDo =
    data !== undefined &&
    data.stockouts.total === 0 &&
    data.belowReorderPoint.total === 0 &&
    data.deadStock.total === 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">What to act on today</h1>
        <p className="text-sm text-muted-foreground">
          The stock that needs a decision, worst first. Everything here links to the item it is
          about.
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
          <p className="font-medium text-destructive">Could not build the dashboard</p>
          <p className="mt-1 text-sm text-muted-foreground">{query.error.message}</p>
        </div>
      )}

      {data && nothingToDo && (
        <div className="rounded-lg border border-border bg-card p-12 text-center">
          <PackageSearch className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 font-medium">
            {data.itemsConsidered === 0
              ? 'There is nothing to act on because there is nothing here'
              : 'Nothing needs a decision today'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.itemsConsidered === 0
              ? 'This screen ranks stock by how much it is costing you. It needs some stock first.'
              : `Checked ${data.itemsConsidered} active ${
                  data.itemsConsidered === 1 ? 'SKU' : 'SKUs'
                }. None is out, low, or sitting idle.`}
          </p>
          {/* Renders only on an instance with nothing in it at all, which is
              the one case where this screen has no way to become useful on its
              own terms. */}
          <FirstRunHint className="mt-4" />
        </div>
      )}

      {data && (
        <>
          {data.stockouts.total > 0 && (
            <Section
              icon={AlertTriangle}
              tone="destructive"
              title="Out of stock"
              description="Nothing on hand anywhere. Ranked by the value of demand going unmet each day."
              shown={data.stockouts.rows.length}
              total={data.stockouts.total}
            >
              {data.stockouts.rows.map((row) => (
                <ReorderRow key={row.itemId} suggestion={row} action="Receive" />
              ))}
            </Section>
          )}

          {data.belowReorderPoint.total > 0 && (
            <Section
              icon={TrendingDown}
              tone="warning"
              title="Below reorder point"
              description={`At or under the configured reorder point. Ranked by how soon they run out, at a ${data.leadTimeDays}-day lead time and ${data.serviceLevel}% service level.`}
              shown={data.belowReorderPoint.rows.length}
              total={data.belowReorderPoint.total}
            >
              {data.belowReorderPoint.rows.map((row) => (
                <ReorderRow key={row.itemId} suggestion={row} action="Reorder" />
              ))}
            </Section>
          )}

          {data.deadStock.total > 0 && (
            <Section
              icon={Snowflake}
              tone="muted"
              title="Dead stock"
              description={`Nothing issued for ${data.deadStockDays} days or more. Ranked by the capital sitting in it — ${formatCents(data.deadStock.valueCents)} across all ${data.deadStock.total}.`}
              shown={data.deadStock.rows.length}
              total={data.deadStock.total}
            >
              {data.deadStock.rows.map((row) => (
                <DeadStockListRow key={row.itemId} row={row} />
              ))}
            </Section>
          )}
        </>
      )}

      {/* Outside the "is there anything to do" branch on purpose. An empty
          dashboard is exactly where a reader concludes no delivery is late. */}
      {data && <LateDeliveriesNotice />}

      {data && <ContextStrip data={data} />}
    </div>
  );
}

const TONE_CLASS = {
  destructive: 'text-destructive',
  warning: 'text-warning',
  muted: 'text-muted-foreground',
} as const;

function Section({
  icon: Icon,
  tone,
  title,
  description,
  shown,
  total,
  children,
}: {
  icon: typeof AlertTriangle;
  tone: keyof typeof TONE_CLASS;
  title: string;
  description: string;
  shown: number;
  total: number;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 font-medium">
          <Icon className={cn('h-4 w-4', TONE_CLASS[tone])} aria-hidden />
          {title}
          <span className="tabular text-sm font-normal text-muted-foreground">{total}</span>
        </h2>
        {shown < total && (
          <p className="text-xs text-muted-foreground">
            {/* The shortlist has to say it is one, or five rows reads as five problems. */}
            showing the worst {shown} of {total} SKUs
          </p>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
      <ul className="space-y-2">{children}</ul>
    </section>
  );
}

/**
 * Purchase orders do not exist yet (INVX-27), so nothing in this product knows
 * what is incoming or when it was promised.
 *
 * Saying that out loud beats leaving the section out. An empty dashboard reads
 * as "no deliveries are late", and somebody would believe it.
 */
function LateDeliveriesNotice() {
  return (
    <section className="rounded-lg border border-dashed border-border p-4">
      <h2 className="flex items-center gap-2 font-medium text-muted-foreground">
        <Truck className="h-4 w-4" aria-hidden />
        Late incoming deliveries
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Not available yet. Purchase orders have not been built, so nothing here knows what is on its
        way or when it was promised — this section is empty because the data does not exist, not
        because every delivery is on time.
      </p>
    </section>
  );
}

function ReorderRow({
  suggestion,
  action,
}: {
  suggestion: ReorderSuggestion;
  action: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-label={`Show the working for ${suggestion.sku}`}
          className="text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
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
          {/* Until purchase orders exist, the action is the item page: it holds
              the working, the history, and the way on to the movement forms.
              Labelled with the SKU so a screen reader is not read a column of
              identical "Reorder" links. */}
          <Link to={`/items/${suggestion.itemId}`} aria-label={`${action} ${suggestion.sku}`}>
            {action}
          </Link>
        </Button>
      </div>

      {expanded && (
        <div className="border-t border-border bg-muted/30 px-4 py-3 text-sm">
          <p className="mb-2 font-medium">How this was worked out</p>
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <Working
              label="Average daily demand"
              value={`${suggestion.averageDailyDemand.toFixed(2)} ${suggestion.unitOfMeasure}/day`}
            />
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
              {suggestion.suggestedReorderPoint > suggestion.currentReorderPoint
                ? 'too low'
                : 'too high'}
            </Badge>
          )}
        </div>
      )}
    </li>
  );
}

function DeadStockListRow({ row }: { row: DeadStockRow }) {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-4">
      <div className="min-w-[160px] flex-1">
        <p className="font-medium tabular">{row.sku}</p>
        <p className="truncate text-sm text-muted-foreground">{row.name}</p>
      </div>

      <div className="text-sm">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">On hand</p>
        <p className="tabular">
          {row.onHand.toLocaleString()}{' '}
          <span className="text-xs text-muted-foreground">{row.unitOfMeasure}</span>
        </p>
      </div>

      <div className="text-sm">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Tied up</p>
        <p className="tabular font-medium">{formatCents(row.valueOnHandCents)}</p>
      </div>

      <div className="text-sm">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Idle</p>
        <p className="tabular font-medium">
          {row.daysStale.toLocaleString()} days
          {row.neverIssued && (
            <span className="ml-1 text-xs font-normal text-muted-foreground">never issued</span>
          )}
        </p>
      </div>

      <Button asChild variant="outline" size="sm">
        <Link to={`/items/${row.itemId}`} aria-label={`Review ${row.sku}`}>
          Review
        </Link>
      </Button>
    </li>
  );
}

/**
 * Total value and how busy the warehouse is.
 *
 * Below the lists and in muted type on purpose: the ticket that asked for these
 * asked for them as context rather than as the headline, and a big number at
 * the top of a screen is a headline no matter what the label says.
 */
function ContextStrip({
  data,
}: {
  data: NonNullable<ReturnType<typeof useDashboard>['data']>;
}) {
  return (
    <section className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-2">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Total inventory value
        </p>
        <p className="tabular text-lg font-medium">{formatCents(data.inventoryValueCents)}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          At cost, across {data.itemsConsidered.toLocaleString()} active{' '}
          {data.itemsConsidered === 1 ? 'SKU' : 'SKUs'}.
        </p>
      </div>

      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Movement volume</p>
        <MovementSparkline
          series={data.movementVolume.series}
          windowDays={data.movementVolume.windowDays}
        />
      </div>
    </section>
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
