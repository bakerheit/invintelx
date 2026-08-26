import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, SlidersHorizontal } from 'lucide-react';
import type { Movement } from '@invintelx/shared';
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
import { useAuth } from '@/features/auth/AuthProvider';
import { formatMovementDate } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { MoveForm } from './MoveForm';
import { TransferForm } from './TransferForm';
import { AdjustForm } from './AdjustForm';
import { useMovements } from './api';

const OPERATIONS = [
  { key: 'receive', label: 'Receive', icon: ArrowDownToLine },
  { key: 'issue', label: 'Issue', icon: ArrowUpFromLine },
  { key: 'transfer', label: 'Transfer', icon: ArrowLeftRight },
  { key: 'adjust', label: 'Adjust', icon: SlidersHorizontal },
] as const;

type Operation = (typeof OPERATIONS)[number]['key'];

const MOVEMENT_LABEL: Record<Movement['type'], string> = {
  receipt: 'Received',
  issue: 'Issued',
  transfer: 'Transferred',
  adjustment: 'Adjusted',
  count: 'Counted',
};

const PAGE_SIZE = 15;

/**
 * The screen that writes the ledger.
 *
 * One section, one form per operation, because the operations share their whole
 * vocabulary — item, bin, quantity, reference — and putting them on four pages
 * would make choosing the right one a navigation problem.
 */
export function MovementsPage() {
  const { user } = useAuth();
  const [operation, setOperation] = useState<Operation>('receive');
  const [page, setPage] = useState(1);

  const movements = useMovements({ page, pageSize: PAGE_SIZE });
  const canWrite = user?.role !== 'viewer';

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Movements</h1>
        <p className="text-sm text-muted-foreground">
          Every change to stock is a movement. Nothing here edits history — a mistake is corrected
          by posting its opposite.
        </p>
      </div>

      {canWrite ? (
        <>
          <div
            role="tablist"
            aria-label="Movement type"
            className="flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1"
          >
            {OPERATIONS.map((op) => (
              <button
                key={op.key}
                type="button"
                role="tab"
                aria-selected={operation === op.key}
                onClick={() => setOperation(op.key)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  operation === op.key
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <op.icon className="h-4 w-4" />
                {op.label}
              </button>
            ))}
          </div>

          {/* Keyed so switching operation starts a clean form rather than
              carrying a half-filled one across. */}
          {operation === 'receive' && <MoveForm key="receive" kind="receive" />}
          {operation === 'issue' && <MoveForm key="issue" kind="issue" />}
          {operation === 'transfer' && <TransferForm key="transfer" />}
          {operation === 'adjust' && <AdjustForm key="adjust" />}
        </>
      ) : (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <p className="font-medium">Your account can read the ledger, not write it</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Recording movements needs the member role. The history below is still yours to read.
          </p>
        </div>
      )}

      <section className="space-y-3">
        <div>
          <h2 className="font-medium">Recent movements</h2>
          <p className="text-sm text-muted-foreground">
            Newest first, across every item. Reversing one is done from its item&apos;s history.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>When</TableHead>
                <TableHead>What</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Where</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead>Who</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {movements.isLoading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i} className="hover:bg-transparent">
                    {Array.from({ length: 6 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full max-w-[100px]" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

              {!movements.isLoading &&
                movements.data?.data.map((movement) => (
                  <TableRow key={movement.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatMovementDate(movement.occurredAt)}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1.5">
                        {MOVEMENT_LABEL[movement.type]}
                        {movement.reversesId && (
                          <Badge variant="outline" className="text-[10px]">
                            reversal
                          </Badge>
                        )}
                      </span>
                      {movement.reference && (
                        <span className="text-xs text-muted-foreground tabular">
                          {movement.reference}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Link
                        to={`/items/${movement.itemId}`}
                        className="tabular text-primary hover:underline"
                      >
                        {movement.itemSku}
                      </Link>
                    </TableCell>
                    <TableCell className="tabular text-muted-foreground">
                      {movement.locationCode}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular',
                        movement.quantity > 0 ? 'text-success' : 'text-foreground',
                      )}
                    >
                      {movement.quantity > 0 ? '+' : ''}
                      {movement.quantity.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{movement.actorName}</TableCell>
                  </TableRow>
                ))}

              {!movements.isLoading && movements.data?.data.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="py-12 text-center">
                    <p className="font-medium">Nothing has moved yet</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Receive some stock above and it appears here.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {movements.data && movements.data.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <p className="tabular">
              {(movements.data.page - 1) * movements.data.pageSize + 1}
              {'-'}
              {Math.min(movements.data.page * movements.data.pageSize, movements.data.total)} of{' '}
              {movements.data.total}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={movements.data.page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="tabular px-1">
                Page {movements.data.page} of {movements.data.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={movements.data.page >= movements.data.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
