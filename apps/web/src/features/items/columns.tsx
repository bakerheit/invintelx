import type { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal } from 'lucide-react';
import { formatCents, type Item } from '@invintelx/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ColumnActions {
  onEdit: (item: Item) => void;
  onArchive: (item: Item) => void;
  onRestore: (item: Item) => void;
}

export function buildItemColumns({
  onEdit,
  onArchive,
  onRestore,
}: ColumnActions): ColumnDef<Item, unknown>[] {
  return [
    {
      id: 'sku',
      header: 'SKU',
      cell: ({ row }) => <span className="font-medium tabular">{row.original.sku}</span>,
    },
    {
      id: 'name',
      header: 'Name',
      cell: ({ row }) => (
        <div className="min-w-[180px]">
          <p className="truncate">{row.original.name}</p>
          {row.original.barcode && (
            <p className="truncate text-xs text-muted-foreground tabular">{row.original.barcode}</p>
          )}
        </div>
      ),
    },
    {
      id: 'category',
      header: 'Category',
      cell: ({ row }) =>
        row.original.category ? (
          <Badge variant="secondary">{row.original.category}</Badge>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    {
      id: 'unitCostCents',
      header: 'Cost',
      cell: ({ row }) => <span className="tabular">{formatCents(row.original.unitCostCents)}</span>,
    },
    {
      id: 'unitPriceCents',
      header: 'Price',
      cell: ({ row }) => <span className="tabular">{formatCents(row.original.unitPriceCents)}</span>,
    },
    {
      id: 'reorderPoint',
      header: 'Reorder at',
      cell: ({ row }) => (
        <span className="tabular">
          {row.original.reorderPoint.toLocaleString()}{' '}
          <span className="text-xs text-muted-foreground">{row.original.unitOfMeasure}</span>
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      enableSorting: false,
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Actions for ${item.sku}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onEdit(item)}>Edit</DropdownMenuItem>
                {item.status === 'active' ? (
                  <DropdownMenuItem destructive onSelect={() => onArchive(item)}>
                    Archive
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => onRestore(item)}>Restore</DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];
}
