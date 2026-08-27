import { useState } from 'react';
import type { AuditEntityType } from '@invintelx/shared';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AuditEntryRow } from './AuditEntryRow';
import { useEntityAudit } from './api';

/**
 * The history of one record's edits, for the page that record lives on.
 *
 * Sits alongside the movement history rather than replacing it: one says how
 * the quantity got where it is, this one says how the cost, the reorder point
 * and the status did. Between them there is no change to an item that nobody
 * can account for.
 */
export function AuditTrail({
  entityType,
  entityId,
  title = 'Change history',
  description = 'Every edit to this record that was not a stock movement, newest first.',
}: {
  entityType: AuditEntityType;
  entityId: string;
  title?: string;
  description?: string;
}) {
  const [page, setPage] = useState(1);
  const audit = useEntityAudit(entityType, entityId, page);

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      <div className="rounded-lg border border-border bg-card">
        {audit.isLoading && (
          <div className="space-y-3 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}

        {audit.error && (
          <p className="p-4 text-sm text-destructive">
            Could not load the change history. {audit.error.message}
          </p>
        )}

        {!audit.isLoading && !audit.error && audit.data?.data.length === 0 && (
          <div className="py-10 text-center">
            <p className="font-medium">No edits recorded</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Changes to this record will be listed here.
            </p>
          </div>
        )}

        {audit.data && audit.data.data.length > 0 && (
          <ul className="divide-y divide-border">
            {audit.data.data.map((entry) => (
              <AuditEntryRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </div>

      {audit.data && audit.data.totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <Button
            variant="outline"
            size="sm"
            disabled={audit.data.page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="tabular px-1">
            Page {audit.data.page} of {audit.data.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={audit.data.page >= audit.data.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </section>
  );
}
