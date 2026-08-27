import { useEffect, useState } from 'react';
import { Undo2 } from 'lucide-react';
import type { CountSheetLine } from '@invintelx/shared';
import { Input } from '@/components/ui/input';

/**
 * One line's counted quantity.
 *
 * The value is held locally while somebody types and written on blur or Enter,
 * because a request per keystroke would turn "12" into a count of 1 and then a
 * count of 12. Blank is not zero: clearing the box clears the count, and the
 * line goes back to uncounted rather than claiming the shelf was empty.
 */
export function CountEntry({
  line,
  disabled,
  onRecord,
}: {
  line: CountSheetLine;
  disabled: boolean;
  onRecord: (lineId: string, countedQuantity: number | null) => void;
}) {
  const stored = line.countedQuantity === null ? '' : String(line.countedQuantity);
  const [draft, setDraft] = useState(stored);

  // Somebody else's count, or a cleared line, has to reach the box. Keyed off
  // the stored value so it does not fight the keystrokes in progress.
  useEffect(() => setDraft(stored), [stored]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === stored.trim()) return;

    if (trimmed === '') {
      onRecord(line.id, null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 0) {
      setDraft(stored);
      return;
    }
    onRecord(line.id, parsed);
  };

  return (
    <div className="flex items-center justify-end gap-1">
      <Input
        type="number"
        min="0"
        step="1"
        inputMode="numeric"
        aria-label={`Counted quantity for ${line.itemSku}`}
        className="h-9 w-24 text-right tabular"
        value={draft}
        disabled={disabled}
        placeholder="—"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') setDraft(stored);
        }}
      />
      {line.countedQuantity !== null && !disabled && (
        <button
          type="button"
          aria-label={`Clear the count for ${line.itemSku}`}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => onRecord(line.id, null)}
        >
          <Undo2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
