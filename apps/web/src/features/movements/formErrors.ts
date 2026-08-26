import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError } from '@/lib/api';

/**
 * Put a rejected write back on the form.
 *
 * The ledger validates things the form cannot know — that the item is archived,
 * that the bin is a zone, that a transfer's two ends are the same — and returns
 * them keyed by field. Anything that does not match a field on this form still
 * has to be said somewhere, so it lands on the form itself rather than being
 * swallowed.
 */
export function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  known: readonly string[],
  fallback: string,
): void {
  if (error instanceof ApiError && error.fields) {
    const matched = Object.entries(error.fields).filter(([field]) => known.includes(field));
    if (matched.length > 0) {
      for (const [field, message] of matched) setError(field as Path<T>, { message });
      return;
    }
  }
  setError('root', { message: error instanceof ApiError ? error.message : fallback });
}
