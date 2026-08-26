import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
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

export interface DataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  isLoading?: boolean;
  error?: Error | null;
  /** Field currently sorted on, matched against each column's `id`. */
  sort?: string;
  order?: 'asc' | 'desc';
  onSortChange?: (field: string) => void;
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    onPageChange: (page: number) => void;
  };
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
}

/**
 * Presentational only. Sorting and paging are server-side, so this component
 * renders whatever page it is handed and reports intent upward - it never
 * slices the data itself.
 */
export function DataTable<TData>({
  columns,
  data,
  isLoading,
  error,
  sort,
  order,
  onSortChange,
  pagination,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  emptyAction,
}: DataTableProps<TData>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
    ...(pagination ? { pageCount: pagination.totalPages } : {}),
  });

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
        <p className="font-medium text-destructive">Could not load this list</p>
        <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  const showEmpty = !isLoading && data.length === 0;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.columnDef.enableSorting !== false && onSortChange;
                  const isSorted = sort === header.column.id;
                  return (
                    <TableHead key={header.id} className={cn(canSort && 'p-0')}>
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={() => onSortChange(header.column.id)}
                          className="flex h-10 w-full items-center gap-1 px-3 text-left uppercase hover:text-foreground"
                          aria-label={`Sort by ${String(header.column.id)}`}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {isSorted ? (
                            order === 'asc' ? (
                              <ArrowUp className="h-3 w-3" />
                            ) : (
                              <ArrowDown className="h-3 w-3" />
                            )
                          ) : (
                            <ChevronsUpDown className="h-3 w-3 opacity-40" />
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>

          <TableBody>
            {isLoading &&
              Array.from({ length: 8 }).map((_, rowIndex) => (
                <TableRow key={`skeleton-${rowIndex}`} className="hover:bg-transparent">
                  {columns.map((_column, columnIndex) => (
                    <TableCell key={columnIndex}>
                      <Skeleton className="h-4 w-full max-w-[160px]" />
                    </TableCell>
                  ))}
                </TableRow>
              ))}

            {!isLoading &&
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}

            {showEmpty && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="py-16 text-center">
                  <p className="font-medium">{emptyTitle}</p>
                  {emptyDescription && (
                    <p className="mt-1 text-sm text-muted-foreground">{emptyDescription}</p>
                  )}
                  {emptyAction && <div className="mt-4 flex justify-center">{emptyAction}</div>}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {pagination && pagination.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <p className="tabular">
            {(pagination.page - 1) * pagination.pageSize + 1}
            {'-'}
            {Math.min(pagination.page * pagination.pageSize, pagination.total)} of {pagination.total}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => pagination.onPageChange(pagination.page - 1)}
            >
              Previous
            </Button>
            <span className="tabular px-1">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => pagination.onPageChange(pagination.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
