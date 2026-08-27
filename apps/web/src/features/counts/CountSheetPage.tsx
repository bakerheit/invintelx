import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { varianceLabel, type CountSheetLine } from '@invintelx/shared';
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
import { FormError } from '@/features/movements/FormParts';
import { formatMovementDate } from '@/lib/dates';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CountEntry } from './CountEntry';
import { VarianceSummary } from './VarianceSummary';
import {
  TONE_BADGE,
  acceptSummary,
  acceptableLineIds,
  expectedToCounted,
  sortForCounting,
  sortForReview,
  toneOf,
} from './varianceView';
import {
  useCancelCountSheet,
  useCountSheet,
  usePostCountSheet,
  useRecordCount,
} from './api';

type View = 'counting' | 'variance';

/**
 * One count sheet: the entry pad while it is open, and the variance report once
 * there is anything to report.
 *
 * The two views are the same lines in two orders. Counting walks the shelf, so
 * it is by SKU and never re-sorts under a finger. Reviewing argues about the
 * worst line, so it leads with the biggest gap.
 */
export function CountSheetPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const sheet = useCountSheet(id);

  const [view, setView] = useState<View>('counting');
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const record = useRecordCount(id);
  const post = usePostCountSheet(id);
  const cancel = useCancelCountSheet(id);

  const data = sheet.data;
  const isOpen = data?.status === 'open';
  const canWrite = user?.role !== 'viewer';

  const lines = useMemo(
    () => (data ? (view === 'counting' ? sortForCounting(data.lines) : sortForReview(data.lines)) : []),
    [data, view],
  );

  /*
   * Nothing is ticked until somebody ticks it, and "everything counted" is the
   * starting point only once they ask for it. A selection that defaulted to the
   * whole sheet would make accepting the lot the path of least resistance,
   * which is the opposite of what an approval is for.
   */
  const ticked = selected ?? new Set<string>();
  const plan = data ? acceptSummary(data.lines, ticked) : { movements: 0, netQuantity: 0, agreed: 0 };

  const toggle = (lineId: string) => {
    setSelected((current) => {
      const next = new Set(current ?? []);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  };

  const onRecord = (lineId: string, countedQuantity: number | null) => {
    setError(null);
    record.mutate(
      { lineId, countedQuantity },
      {
        onError: (caught) =>
          setError(caught instanceof ApiError ? caught.message : 'Could not record that count'),
      },
    );
  };

  const onPost = async () => {
    if (!data || ticked.size === 0) return;
    setError(null);
    try {
      const result = await post.mutateAsync({ lineIds: [...ticked], note: '' });
      setSelected(null);
      toast.success(
        result.movements.length === 0
          ? `${data.reference} closed with nothing to correct`
          : `${data.reference} posted ${result.movements.length} adjustment${result.movements.length === 1 ? '' : 's'}`,
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not accept those variances',
      );
    }
  };

  const onCancel = async () => {
    setError(null);
    try {
      await cancel.mutateAsync({ note: '' });
      toast.success('Sheet cancelled. Nothing was written.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not cancel this sheet');
    }
  };

  if (sheet.isLoading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-5xl rounded-lg border border-border bg-card p-8 text-center">
        <p className="font-medium">No such count sheet</p>
        <Link to="/counts" className="mt-2 inline-block text-sm text-primary hover:underline">
          Back to cycle counts
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link
          to="/counts"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Cycle counts
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="tabular text-2xl font-semibold tracking-tight">{data.reference}</h1>
          <Badge variant={data.status === 'posted' ? 'success' : 'outline'}>{data.status}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="tabular">{data.locationPathLabel}</span> · opened by {data.createdByName}{' '}
          {formatMovementDate(data.createdAt)}
          {data.postedAt ? ` · posted by ${data.postedByName} ${formatMovementDate(data.postedAt)}` : ''}
        </p>
        {data.note && <p className="mt-1 text-sm">{data.note}</p>}
      </div>

      <VarianceSummary summary={data.summary} />

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div role="tablist" aria-label="Sheet view" className="flex gap-1">
            <Button
              role="tab"
              aria-selected={view === 'counting'}
              variant={view === 'counting' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setView('counting')}
            >
              Counting order
            </Button>
            <Button
              role="tab"
              aria-selected={view === 'variance'}
              variant={view === 'variance' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setView('variance')}
            >
              Worst first
            </Button>
          </div>

          {isOpen && canWrite && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelected(new Set(acceptableLineIds(data.lines)))}
              >
                Tick every counted line
              </Button>
              <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>
                Clear ticks
              </Button>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {isOpen && canWrite && <TableHead className="w-10">Accept</TableHead>}
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Expected → counted</TableHead>
                <TableHead className="text-right">
                  {isOpen && canWrite ? 'Count' : 'Counted'}
                </TableHead>
                <TableHead>Variance</TableHead>
                <TableHead>Counted by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line: CountSheetLine) => {
                const tone = toneOf(line);
                return (
                  <TableRow key={line.id}>
                    {isOpen && canWrite && (
                      <TableCell>
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[hsl(var(--primary))]"
                          aria-label={`Accept the variance for ${line.itemSku}`}
                          checked={ticked.has(line.id)}
                          disabled={line.countedQuantity === null}
                          onChange={() => toggle(line.id)}
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <Link
                        to={`/items/${line.itemId}`}
                        className="tabular text-primary hover:underline"
                      >
                        {line.itemSku}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{line.itemName}</span>
                    </TableCell>
                    <TableCell className="text-right tabular text-muted-foreground">
                      {expectedToCounted(line)}
                    </TableCell>
                    <TableCell className="text-right">
                      {isOpen && canWrite ? (
                        <CountEntry line={line} disabled={record.isPending} onRecord={onRecord} />
                      ) : (
                        <span className="tabular">
                          {line.countedQuantity === null ? '—' : line.countedQuantity}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={TONE_BADGE[tone]}>{varianceLabel(line.variance)}</Badge>
                      {line.postedMovementId && (
                        <span
                          className={cn(
                            'tabular ml-2 text-xs',
                            (line.postedQuantity ?? 0) < 0 ? 'text-destructive' : 'text-warning',
                          )}
                        >
                          posted {(line.postedQuantity ?? 0) > 0 ? '+' : ''}
                          {line.postedQuantity}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {line.countedByName || '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {error && <FormError message={error} />}

        {isOpen && canWrite && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
            <div className="text-sm">
              <p className="font-medium">
                {plan.movements === 0
                  ? ticked.size === 0
                    ? 'Nothing ticked yet'
                    : 'Ticked lines all agree — closing this sheet writes nothing'
                  : `${plan.movements} adjustment${plan.movements === 1 ? '' : 's'}, ${plan.netQuantity > 0 ? '+' : ''}${plan.netQuantity.toLocaleString()} units net`}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                Accepting posts the difference, not the count — anything that moved since this sheet
                was opened stays on the books.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void onCancel()} disabled={cancel.isPending}>
                Cancel sheet
              </Button>
              <Button
                onClick={() => void onPost()}
                disabled={ticked.size === 0 || post.isPending}
              >
                {post.isPending ? 'Posting...' : `Accept ${ticked.size} line${ticked.size === 1 ? '' : 's'}`}
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
