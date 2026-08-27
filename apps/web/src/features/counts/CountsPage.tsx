import { useState } from 'react';
import { Link } from 'react-router';
import { varianceHeadline, type CountSheet, type CountSheetStatus } from '@invintelx/shared';
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
import { NewCountForm } from './NewCountForm';
import { accuracyLabel } from './varianceView';
import { useCountSheets } from './api';

const STATUS_BADGE: Record<CountSheetStatus, 'default' | 'success' | 'outline'> = {
  open: 'default',
  posted: 'success',
  cancelled: 'outline',
};

const FILTERS: { key: string; label: string; status?: CountSheetStatus }[] = [
  { key: 'open', label: 'Open', status: 'open' },
  { key: 'posted', label: 'Posted', status: 'posted' },
  { key: 'cancelled', label: 'Cancelled', status: 'cancelled' },
  { key: 'all', label: 'All' },
];

const PAGE_SIZE = 15;

/**
 * Cycle counts: the sheets, and the form that cuts a new one.
 *
 * The list leads with the variance rather than with the status, because "how
 * wrong were we" is the question somebody opens this screen to answer. A row
 * that only said "posted" would be a receipt for a decision nobody can see.
 */
export function CountsPage() {
  const { user } = useAuth();
  const [filter, setFilter] = useState('open');
  const [page, setPage] = useState(1);

  const status = FILTERS.find((f) => f.key === filter)?.status;
  const sheets = useCountSheets({ page, pageSize: PAGE_SIZE, ...(status ? { status } : {}) });
  const canWrite = user?.role !== 'viewer';

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cycle counts</h1>
        <p className="text-sm text-muted-foreground">
          Count a bin, compare it with what the books say, and accept the differences you believe.
          An accepted difference is posted as an adjustment — the count itself never overwrites the
          ledger.
        </p>
      </div>

      {canWrite ? (
        <NewCountForm />
      ) : (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <p className="font-medium">Your account can read counts, not run them</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Opening a sheet and accepting variances needs the member role.
          </p>
        </div>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-medium">Count sheets</h2>
            <p className="text-sm text-muted-foreground">Newest first.</p>
          </div>
          <div role="tablist" aria-label="Sheet status" className="flex flex-wrap gap-1">
            {FILTERS.map((option) => (
              <Button
                key={option.key}
                type="button"
                role="tab"
                aria-selected={filter === option.key}
                variant={filter === option.key ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setFilter(option.key);
                  setPage(1);
                }}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Sheet</TableHead>
                <TableHead>Bin</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Variance</TableHead>
                <TableHead className="text-right">Accuracy</TableHead>
                <TableHead>Opened</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sheets.isLoading &&
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i} className="hover:bg-transparent">
                    {Array.from({ length: 6 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full max-w-[120px]" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

              {!sheets.isLoading &&
                sheets.data?.data.map((sheet: CountSheet) => (
                  <TableRow key={sheet.id}>
                    <TableCell>
                      <Link
                        to={`/counts/${sheet.id}`}
                        className="tabular font-medium text-primary hover:underline"
                      >
                        {sheet.reference}
                      </Link>
                      <div className="mt-0.5">
                        <Badge variant={STATUS_BADGE[sheet.status]} className="text-[10px]">
                          {sheet.status}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="tabular">{sheet.locationCode}</span>
                      <span className="block text-xs text-muted-foreground">
                        {sheet.locationPathLabel}
                      </span>
                    </TableCell>
                    <TableCell className="tabular text-muted-foreground">
                      {sheet.summary.countedCount} of {sheet.summary.lineCount} counted
                    </TableCell>
                    <TableCell>{varianceHeadline(sheet.summary)}</TableCell>
                    <TableCell className="text-right tabular">
                      {accuracyLabel(sheet.summary.accuracy)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatMovementDate(sheet.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}

              {!sheets.isLoading && sheets.data?.data.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="py-12 text-center">
                    <p className="font-medium">No sheets here</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {filter === 'open'
                        ? 'Nothing is being counted right now.'
                        : 'Nothing has reached this state yet.'}
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {sheets.data && sheets.data.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <p className="tabular">
              {(sheets.data.page - 1) * sheets.data.pageSize + 1}
              {'-'}
              {Math.min(sheets.data.page * sheets.data.pageSize, sheets.data.total)} of{' '}
              {sheets.data.total}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={sheets.data.page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="tabular px-1">
                Page {sheets.data.page} of {sheets.data.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={sheets.data.page >= sheets.data.totalPages}
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
