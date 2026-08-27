import { useQuery } from '@tanstack/react-query';
import {
  auditListResponseSchema,
  type AuditAction,
  type AuditEntityType,
} from '@invintelx/shared';
import { apiRequest, toQueryString } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/** One entity's history. Readable by anyone who can read the entity. */
export function useEntityAudit(
  entityType: AuditEntityType,
  entityId: string,
  page: number,
  pageSize = 10,
) {
  return useQuery({
    queryKey: queryKeys.audit.entity(entityType, entityId, page, pageSize),
    queryFn: () =>
      apiRequest(
        auditListResponseSchema,
        `/audit/${entityType}/${entityId}${toQueryString({ page, pageSize })}`,
      ),
    enabled: entityId !== '',
    // Keeps the current page on screen while the next one loads, so paging does
    // not flash an empty list.
    placeholderData: (previous) => previous,
  });
}

export interface AuditFeedQuery {
  page: number;
  pageSize?: number;
  entityType?: AuditEntityType | '';
  action?: AuditAction | '';
  /** So the whole query can serve as a cache key, which takes a loose record. */
  [key: string]: unknown;
}

/**
 * The whole log. The server refuses this to anyone below admin, so the page
 * that uses it checks the role too rather than rendering a request it knows
 * will be turned down.
 */
export function useAuditFeed(query: AuditFeedQuery, enabled = true) {
  return useQuery({
    queryKey: queryKeys.audit.feed(query),
    queryFn: () =>
      apiRequest(
        auditListResponseSchema,
        `/audit${toQueryString({
          page: query.page,
          pageSize: query.pageSize,
          entityType: query.entityType,
          action: query.action,
        })}`,
      ),
    enabled,
    placeholderData: (previous) => previous,
  });
}
