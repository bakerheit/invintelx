import { useEffect, useId, useRef, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface SearchPickerProps<T> {
  label: string;
  placeholder: string;
  /** What is currently chosen, or null. Owned by the caller. */
  value: T | null;
  onChange: (option: T | null) => void;
  options: readonly T[];
  isLoading: boolean;
  getKey: (option: T) => string;
  /** The line people scan for — a SKU, a bin code. Rendered tabular. */
  getLabel: (option: T) => string;
  /** The line that tells them they picked the right one. */
  getDescription: (option: T) => string;
  query: string;
  onQueryChange: (query: string) => void;
  error?: string | undefined;
  emptyText: string;
}

/**
 * Search-and-choose, for anywhere the API wants an id and a person has a name.
 *
 * Typing a 24-character ObjectId is not a workflow anybody has; every id in
 * these forms is chosen from here, and the id itself is never shown. Results
 * come from the server, so this list is whatever the caller's query returned —
 * it does no filtering of its own.
 */
export function SearchPicker<T>({
  label,
  placeholder,
  value,
  onChange,
  options,
  isLoading,
  getKey,
  getLabel,
  getDescription,
  query,
  onQueryChange,
  error,
  emptyText,
}: SearchPickerProps<T>) {
  const id = useId();
  const listId = `${id}-list`;
  const errorId = `${id}-error`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // A stale index after the results change would highlight a row that is no
  // longer there, and Enter would then choose something nobody looked at.
  useEffect(() => setActiveIndex(0), [options]);

  const choose = (option: T) => {
    onChange(option);
    setOpen(false);
    onQueryChange('');
  };

  const clear = () => {
    onChange(null);
    onQueryChange('');
    setOpen(true);
    // Focus lands back where the next keystroke should go.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  /**
   * Shown under either branch.
   *
   * A chosen value is not the same as a valid one — "pick two different bins"
   * lands on a picker that is holding a bin — so the error has to survive the
   * switch from searching to chosen, or the form rejects a submit and says
   * nothing about why.
   */
  const errorMessage = error ? (
    <p id={errorId} role="alert" className="text-xs text-destructive">
      {error}
    </p>
  ) : null;

  if (value) {
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-chosen`}>{label}</Label>
        <div
          id={`${id}-chosen`}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            'flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm',
            error && 'border-destructive',
          )}
        >
          <Check className="h-3.5 w-3.5 shrink-0 text-success" />
          <span className="tabular font-medium">{getLabel(value)}</span>
          <span className="truncate text-muted-foreground">{getDescription(value)}</span>
          <button
            type="button"
            onClick={clear}
            className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Change ${label.toLowerCase()}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {errorMessage}
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={id}
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          className="pl-9"
          placeholder={placeholder}
          value={query}
          onFocus={() => setOpen(true)}
          // Losing focus to anywhere that is not an option closes the list. The
          // options cancel their own mousedown, so clicking one never gets here.
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            onQueryChange(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((i) => Math.min(i + 1, options.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((i) => Math.max(i - 1, 0));
            } else if (event.key === 'Enter') {
              // Swallowed rather than submitting the form: Enter in a picker
              // means "take the highlighted one", every time.
              event.preventDefault();
              const option = options[activeIndex];
              if (open && option) choose(option);
            } else if (event.key === 'Escape') {
              setOpen(false);
            }
          }}
        />

        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label={label}
            className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md"
          >
            {isLoading && (
              <li className="space-y-2 p-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </li>
            )}

            {!isLoading && options.length === 0 && (
              <li className="px-2 py-6 text-center text-sm text-muted-foreground">{emptyText}</li>
            )}

            {!isLoading &&
              options.map((option, index) => (
                <li key={getKey(option)}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    // Keeps the input focused, so blur does not tear the list
                    // down before the click lands.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(option)}
                    className={cn(
                      'flex w-full items-baseline gap-2 rounded-md px-2 py-2 text-left text-sm',
                      index === activeIndex && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <span className="tabular font-medium">{getLabel(option)}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {getDescription(option)}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>

      {errorMessage}
    </div>
  );
}
