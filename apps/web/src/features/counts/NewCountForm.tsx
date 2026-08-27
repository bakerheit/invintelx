import { useState } from 'react';
import { useNavigate } from 'react-router';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import type { Item, Location } from '@invintelx/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { FormCard, FormError } from '@/features/movements/FormParts';
import { BinPicker, ItemPicker } from '@/features/movements/pickers';
import { ApiError } from '@/lib/api';
import { useCreateCountSheet } from './api';

/**
 * Cut a sheet.
 *
 * A bin is required and items are not: the common count is "everything the
 * books say is in this bin", and naming items is the narrower case — a spot
 * check, or a hunt for a SKU the records claim is not there at all.
 */
export function NewCountForm() {
  const navigate = useNavigate();
  const create = useCreateCountSheet();

  const [bin, setBin] = useState<Location | null>(null);
  const [picked, setPicked] = useState<Item[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const addItem = (item: Item | null) => {
    if (!item) return;
    setPicked((current) => (current.some((i) => i.id === item.id) ? current : [...current, item]));
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!bin) {
      setError('Pick a bin to count');
      return;
    }
    setError(null);

    try {
      const sheet = await create.mutateAsync({
        locationId: bin.id,
        itemIds: picked.map((item) => item.id),
        note,
      });
      toast.success(`${sheet.reference} is ready to count — ${sheet.lines.length} lines`);
      void navigate(`/counts/${sheet.id}`);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not open a sheet for that bin',
      );
    }
  };

  return (
    <FormCard
      title="Start a count"
      description="A sheet freezes what the books say right now. Whatever moves afterwards is somebody else's movement, not your variance."
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <BinPicker value={bin} onChange={setBin} label="Bin to count" />

        <div className="grid gap-1.5">
          <ItemPicker
            value={null}
            onChange={addItem}
            label="Specific items (optional)"
          />
          <p className="text-xs text-muted-foreground">
            Leave this empty to count everything the books place in the bin. Naming items narrows
            the sheet to those — including ones the records say are not there.
          </p>
          {picked.length > 0 && (
            <ul className="flex flex-wrap gap-1.5 pt-1">
              {picked.map((item) => (
                <li key={item.id}>
                  <Badge variant="outline" className="gap-1 py-1">
                    <span className="tabular">{item.sku}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${item.sku}`}
                      onClick={() => setPicked((current) => current.filter((i) => i.id !== item.id))}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="count-note">Note</Label>
          <Input
            id="count-note"
            value={note}
            maxLength={500}
            placeholder="Quarterly count, chilled aisle"
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        {error && <FormError message={error} />}

        <div className="flex justify-end">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Opening...' : 'Open count sheet'}
          </Button>
        </div>
      </form>
    </FormCard>
  );
}
