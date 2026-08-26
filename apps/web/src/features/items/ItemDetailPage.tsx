import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, ArrowDownRight, ArrowUpRight, Pencil } from 'lucide-react';
import { formatCents, type Movement, type MovementWithBalance } from '@invintelx/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useItem, useItemDemand, useItemHistory, useItemStock } from './api';
import { DemandSparkline } from './DemandSparkline';
import { ItemDialog } from './ItemDialog';

const MOVEMENT_LABEL: Record<Movement['type'], string> = {
  receipt: 'Received',
  issue: 'Issued',
  transfer: 'Transferred',
  adjustment: 'Adjusted',
  count: 'Counted',
};

export function ItemDetailPage() {
  const { id = '' } = useParams();
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(false);

  const item = useItem(id);
  const stock = useItemStock(id);
  const history = useItemHistory(id, page);
  const demand = useItemDemand(id);

  if (item.error) {
    return (
      <div className="mx-auto max-w-4xl rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
        <p className="font-medium text-destructive">Could not load this item</p>
        <p className="mt-1 text-sm text-muted-foreground">{item.error.message}</p>
        <Button asChild variant="outline" className="mt-4">
          <Link to="/items">Back to items</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/items">
          <ArrowLeft /> Items
        </Link>
      </Button>

      {item.isLoading || !item.data ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight tabular">{item.data.sku}</h1>
              {item.data.status === 'archived' && <Badge variant="secondary">archived</Badge>}
            </div>
            <p className="text-muted-foreground">{item.data.name}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {item.data.category && <span>{item.data.category}</span>}
              <span>cost {formatCents(item.data.unitCostCents)}</span>
              <span>price {formatCents(item.data.unitPriceCents)}</span>
              <span className="tabular">
                reorder at {item.data.reorderPoint.toLocaleString()}
              </span>
            </div>
          </div>
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil /> Edit
          </Button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-medium">On hand</h2>
          {stock.isLoading || !stock.data ? (
            <Skeleton className="mt-3 h-10 w-24" />
          ) : (
            <>
              <p className="mt-1 text-3xl font-semibold tabular">
                {stock.data.totalOnHand.toLocaleString()}
                <span className="ml-1 text-base font-normal text-muted-foreground">
                  {item.data?.unitOfMeasure}
                </span>
              </p>
              {stock.data.byLocation.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">Not held anywhere yet.</p>
              ) : (
                <ul className="mt-3 space-y-1 text-sm">
                  {stock.data.byLocation.map((level) => (
                    <li key={level.locationId} className="flex justify-between gap-4">
                      <span className="text-muted-foreground tabular">{level.locationCode}</span>
                      <span className="tabular">{level.onHand.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-medium">Weekly demand</h2>
          {demand.isLoading || !demand.data ? (
            <Skeleton className="mt-3 h-16 w-full" />
          ) : (
            <>
              <div className="mt-2">
                <DemandSparkline
                  series={demand.data.stats.series}
                  windowDays={demand.data.stats.windowDays}
                  unitOfMeasure={item.data?.unitOfMeasure ?? 'each'}
                />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <Stat
                  label="Average"
                  value={`${demand.data.stats.averageDailyDemand.toFixed(2)}/day`}
                />
                <Stat label="Variability (σ)" value={demand.data.stats.demandStdDev.toFixed(2)} />
                <Stat
                  label="Days of cover"
                  value={
                    demand.data.suggestion.daysOfCover === null
                      ? 'no demand'
                      : `${demand.data.suggestion.daysOfCover.toFixed(1)}`
                  }
                />
                <Stat
                  label="Suggested reorder"
                  value={demand.data.suggestion.suggestedReorderPoint.toLocaleString()}
                />
              </dl>
            </>
          )}
        </section>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="font-medium">Movement history</h2>
          <p className="text-sm text-muted-foreground">
            Newest first, with the balance at that location after each movement.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>When</TableHead>
                <TableHead>What</TableHead>
                <TableHead>Where</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Who</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.isLoading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i} className="hover:bg-transparent">
                    {Array.from({ length: 6 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full max-w-[100px]" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

              {!history.isLoading &&
                history.data?.data.map((movement) => (
                  <MovementRow key={movement.id} movement={movement} />
                ))}

              {!history.isLoading && history.data?.data.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="py-12 text-center">
                    <p className="font-medium">No movements yet</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Stock appears here once it is received.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {history.data && history.data.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <p className="tabular">
              {(history.data.page - 1) * history.data.pageSize + 1}
              {'-'}
              {Math.min(history.data.page * history.data.pageSize, history.data.total)} of{' '}
              {history.data.total}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={history.data.page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="tabular px-1">
                Page {history.data.page} of {history.data.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={history.data.page >= history.data.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </section>

      <ItemDialog open={editing} onOpenChange={setEditing} item={item.data} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}

/**
 * Rendered in UTC, deliberately.
 *
 * The demand series groups movements into UTC days, so rendering the history in
 * local time makes the two disagree: a movement counted in Thursday's demand
 * bucket displays as Wednesday for anyone west of Greenwich, and reconciling the
 * sparkline against this table becomes impossible. One definition of "what day
 * did this happen", used everywhere.
 */
export function formatMovementDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function MovementRow({ movement }: { movement: MovementWithBalance }) {
  const isInbound = movement.quantity > 0;
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {formatMovementDate(movement.occurredAt)}
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-1.5">
          {isInbound ? (
            <ArrowDownRight className="h-3.5 w-3.5 text-success" />
          ) : (
            <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {MOVEMENT_LABEL[movement.type]}
        </span>
        {movement.reference && (
          <span className="text-xs text-muted-foreground tabular">{movement.reference}</span>
        )}
      </TableCell>
      <TableCell className="tabular text-muted-foreground">{movement.locationCode}</TableCell>
      <TableCell className={cn('text-right tabular', isInbound ? 'text-success' : 'text-foreground')}>
        {isInbound ? '+' : ''}
        {movement.quantity.toLocaleString()}
      </TableCell>
      {/* The point of the whole page: how the number got to where it is. */}
      <TableCell className="text-right tabular font-medium">
        {movement.balanceAfter.toLocaleString()}
      </TableCell>
      <TableCell className="text-muted-foreground">{movement.actorName}</TableCell>
    </TableRow>
  );
}
