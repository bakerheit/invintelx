import { ArrowRight, Lock } from 'lucide-react';
import {
  AUDIT_ACTION_LABEL,
  AUDIT_ENTITY_LABEL,
  type AuditEntry,
} from '@invintelx/shared';
import { Badge } from '@/components/ui/badge';
import { describeChange, REDACTED_PLACEHOLDER } from './changes';

/**
 * One recorded edit.
 *
 * The shape is the same on the item page and in the admin feed — the only
 * difference is whether the entity names itself, which it does not need to when
 * the reader is already looking at it. Two renderings of the same row would be
 * two places for the wording of a change to drift.
 */
export function AuditEntryRow({
  entry,
  showEntity = false,
}: {
  entry: AuditEntry;
  showEntity?: boolean;
}) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <Badge variant="outline">{AUDIT_ACTION_LABEL[entry.action]}</Badge>
        {showEntity && (
          <span>
            <span className="text-muted-foreground">
              {AUDIT_ENTITY_LABEL[entry.entityType]}{' '}
            </span>
            <span className="tabular font-medium">{entry.entityLabel}</span>
          </span>
        )}
        <span className="text-muted-foreground">by</span>
        <span className="font-medium">{entry.actorName}</span>
        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground tabular">
          {formatAuditTimestamp(entry.createdAt)}
        </span>
      </div>

      {entry.changes.length === 0 ? (
        /*
         * An entry with no fields is not a bug. An archival changes a status
         * the action already names, and saving a form without touching anything
         * still means somebody pressed save — saying so is the difference
         * between "nothing changed" and "nobody was here".
         */
        <p className="mt-1 text-sm text-muted-foreground">No field values changed.</p>
      ) : (
        <dl className="mt-2 space-y-1">
          {entry.changes.map((change) => {
            const { label, before, after } = describeChange(change);
            return (
              <div
                key={change.field}
                className="flex flex-wrap items-baseline gap-x-2 text-sm"
              >
                <dt className="min-w-40 text-muted-foreground">{label}</dt>
                <dd className="flex flex-wrap items-baseline gap-2">
                  {change.redacted ? (
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <Lock className="h-3 w-3" />
                      {REDACTED_PLACEHOLDER}
                    </span>
                  ) : (
                    <>
                      <span className="text-muted-foreground line-through decoration-muted-foreground/40">
                        {before}
                      </span>
                      <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="font-medium">{after}</span>
                    </>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </li>
  );
}

/**
 * To the minute, and in UTC for the same reason the movement history is: the
 * two lists sit on the same page and a reader compares them by eye.
 */
export function formatAuditTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
