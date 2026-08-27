import { useState } from 'react';
import { Link } from 'react-router';
import {
  AUDIT_ACTION_LABEL,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_LABEL,
  AUDIT_ENTITY_TYPES,
  type AuditAction,
  type AuditEntityType,
} from '@invintelx/shared';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/AuthProvider';
import { AuditEntryRow } from './AuditEntryRow';
import { useAuditFeed } from './api';

/** The dropdown value for "no filter". Radix will not take an empty string. */
const ANY = 'any';

/**
 * Every edit anyone made to anything, newest first.
 *
 * Admin only, and checked here as well as on the server. The feed is a report
 * on people as much as on data, and a member who lands on this URL should be
 * told why they cannot see it rather than shown a page that fails to load.
 */
export function AuditPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [page, setPage] = useState(1);
  const [entityType, setEntityType] = useState<AuditEntityType | typeof ANY>(ANY);
  const [action, setAction] = useState<AuditAction | typeof ANY>(ANY);

  const feed = useAuditFeed(
    {
      page,
      pageSize: 25,
      entityType: entityType === ANY ? '' : entityType,
      action: action === ANY ? '' : action,
    },
    isAdmin,
  );

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-lg rounded-lg border border-border bg-card p-8 text-center">
        <h1 className="font-semibold">The full audit log is for administrators</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The history of any one record is on that record&apos;s own page, and you can read it
          there.
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link to="/items">Back to items</Link>
        </Button>
      </div>
    );
  }

  /** Reset to the first page whenever the filter changes, or page 7 of the old filter is nonsense. */
  const onFilter = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setPage(1);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-muted-foreground">
          Every change that was not a stock movement — who made it, what it was before, and what it
          became. Stock movements have their own ledger.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="w-48">
          <Select
            value={entityType}
            onValueChange={onFilter<AuditEntityType | typeof ANY>((v) => setEntityType(v))}
          >
            <SelectTrigger aria-label="Filter by kind of record">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All records</SelectItem>
              {AUDIT_ENTITY_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {AUDIT_ENTITY_LABEL[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-48">
          <Select value={action} onValueChange={onFilter<AuditAction | typeof ANY>((v) => setAction(v))}>
            <SelectTrigger aria-label="Filter by action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All actions</SelectItem>
              {AUDIT_ACTIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {AUDIT_ACTION_LABEL[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card">
        {feed.isLoading && (
          <div className="space-y-3 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}

        {feed.error && (
          <p className="p-4 text-sm text-destructive">
            Could not load the audit log. {feed.error.message}
          </p>
        )}

        {!feed.isLoading && !feed.error && feed.data?.data.length === 0 && (
          <div className="py-12 text-center">
            <p className="font-medium">Nothing recorded yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Edits appear here as soon as anybody makes one.
            </p>
          </div>
        )}

        {feed.data && feed.data.data.length > 0 && (
          <ul className="divide-y divide-border">
            {feed.data.data.map((entry) => (
              <AuditEntryRow key={entry.id} entry={entry} showEntity />
            ))}
          </ul>
        )}
      </div>

      {feed.data && feed.data.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <p className="tabular">
            {(feed.data.page - 1) * feed.data.pageSize + 1}
            {'-'}
            {Math.min(feed.data.page * feed.data.pageSize, feed.data.total)} of {feed.data.total}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={feed.data.page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span className="tabular px-1">
              Page {feed.data.page} of {feed.data.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={feed.data.page >= feed.data.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
