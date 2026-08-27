import { useMemo, useState } from 'react';
import { Download, Plus, Search, Upload } from 'lucide-react';
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
import { FirstRunHint } from '@/features/onboarding/FirstRunHint';
import { itemsExportHref, useArchiveItem, useItems, useRestoreItem } from './api';
import { buildItemColumns } from './columns';
import { ItemDialog } from './ItemDialog';
import { ImportDialog } from './ImportDialog';

export function ItemsPage() {
  const { params, update, toggleSort } = useTableParams();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
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
        <div className="flex flex-wrap items-center gap-2">
          {/*
            A plain link, not a fetch: the browser saves what the server marked
            as an attachment, and the href carries the filters currently on
            screen so "export" means the rows being looked at.
          */}
          <Button asChild variant="outline">
            <a href={itemsExportHref(params)} download>
              <Download /> Export CSV
            </a>
          </Button>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload /> Import CSV
          </Button>
          <Button
            onClick={() => {
              setEditing(undefined);
              setDialogOpen(true);
            }}
          >
            <Plus /> New item
          </Button>
        </div>
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
            <div className="space-y-3">
              <Button
                onClick={() => {
                  setEditing(undefined);
                  setDialogOpen(true);
                }}
              >
                <Plus /> New item
              </Button>
              {/* One SKU typed by hand is not a first five minutes. On an
                  instance with nothing in it, say where the other two paths
                  are. */}
              <FirstRunHint />
            </div>
          ) : undefined
        }
      />

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />

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
