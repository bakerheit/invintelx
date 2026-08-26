import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { Item } from '@invintelx/shared';
import { useTableParams } from '@/hooks/useTableParams';
import { DataTable } from '@/components/DataTable';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useArchiveItem, useItems, useRestoreItem } from './api';
import { buildItemColumns } from './columns';
import { ItemDialog } from './ItemDialog';

export function ItemsPage() {
  const { params, update, toggleSort } = useTableParams();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Item | undefined>(undefined);
  const [pendingArchive, setPendingArchive] = useState<Item | null>(null);

  const query = useItems(params);
  const archiveItem = useArchiveItem();
  const restoreItem = useRestoreItem();

  const columns = useMemo(
    () =>
      buildItemColumns({
        onEdit: (item) => {
          setEditing(item);
          setDialogOpen(true);
        },
        onArchive: (item) => setPendingArchive(item),
        onRestore: (item) => {
          restoreItem.mutate(item, {
            onSuccess: () => toast.success(`${item.sku} restored`),
            onError: (error) => toast.error(error.message),
          });
        },
      }),
    [restoreItem],
  );

  const confirmArchive = () => {
    if (!pendingArchive) return;
    const item = pendingArchive;
    setPendingArchive(null);
    archiveItem.mutate(item, {
      onSuccess: () => toast.success(`${item.sku} archived`),
      onError: (error) => toast.error(error.message),
    });
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Items</h1>
          <p className="text-sm text-muted-foreground">
            Every SKU you track. Stock levels arrive with the movement ledger.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditing(undefined);
            setDialogOpen(true);
          }}
        >
          <Plus /> New item
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={params.q}
            onChange={(event) => update({ q: event.target.value })}
            placeholder="Search SKU, name or barcode"
            className="pl-9"
            aria-label="Search items"
          />
        </div>

        <Select value={params.status} onValueChange={(value) => update({ status: value })}>
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={query.data?.data ?? []}
        isLoading={query.isLoading}
        error={query.error}
        sort={params.sort}
        order={params.order}
        onSortChange={toggleSort}
        pagination={{
          page: query.data?.page ?? 1,
          pageSize: query.data?.pageSize ?? params.pageSize,
          total: query.data?.total ?? 0,
          totalPages: query.data?.totalPages ?? 1,
          onPageChange: (page) => update({ page }),
        }}
        emptyTitle={params.q ? 'No items match that search' : 'No items yet'}
        emptyDescription={
          params.q
            ? 'Try a different SKU, name or barcode.'
            : 'Create your first SKU to start tracking inventory.'
        }
        emptyAction={
          !params.q ? (
            <Button
              onClick={() => {
                setEditing(undefined);
                setDialogOpen(true);
              }}
            >
              <Plus /> New item
            </Button>
          ) : undefined
        }
      />

      <ItemDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        item={editing}
        onSaved={(saved) => toast.success(`${saved.sku} saved`)}
      />

      <AlertDialog
        open={pendingArchive !== null}
        onOpenChange={(open) => !open && setPendingArchive(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {pendingArchive?.sku}?</AlertDialogTitle>
            <AlertDialogDescription>
              It disappears from the active list but keeps its history, and any stock movements that
              reference it stay intact. You can restore it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmArchive}>Archive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
