import { z } from 'zod';

/** Mongo ObjectId rendered as a 24-char hex string over the wire. */
export const objectIdSchema = z
  .string()
  .regex(/^[a-f0-9]{24}$/i, 'must be a 24-character hex id');

/** ISO-8601 timestamp. Dates cross the wire as strings, never as Date. */
export const isoDateSchema = z.string().datetime();

export const sortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof sortOrderSchema>;

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Query params arrive as strings. `coerce` lets one schema serve both the
 * client (which has real numbers) and the server (which has strings).
 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Every list endpoint returns this shape so the DataTable never has to special-case. */
export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  });
}

export interface Paginated<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** The body every 4xx/5xx carries, so the client can branch on `code`. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Field-level messages, keyed by dotted path, for form validation failures. */
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
