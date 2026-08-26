import { useState } from 'react';
import type { Item, Location } from '@invintelx/shared';
import { useDebounced } from '@/hooks/useDebounced';
import { SearchPicker } from './SearchPicker';
import { useBinSearch, useItemSearch } from './api';

interface PickerProps<T> {
  value: T | null;
  onChange: (value: T | null) => void;
  error?: string | undefined;
  label?: string;
}

/** Choose a SKU by typing part of it, or part of its name. */
export function ItemPicker({ value, onChange, error, label = 'Item' }: PickerProps<Item>) {
  const [query, setQuery] = useState('');
  const search = useItemSearch(useDebounced(query));

  return (
    <SearchPicker
      label={label}
      placeholder="Search SKU, name or barcode"
      value={value}
      onChange={onChange}
      options={search.data?.data ?? []}
      isLoading={search.isLoading}
      getKey={(item) => item.id}
      getLabel={(item) => item.sku}
      getDescription={(item) => item.name}
      query={query}
      onQueryChange={setQuery}
      error={error}
      emptyText={query ? 'No item matches that' : 'No items yet'}
    />
  );
}

/**
 * Choose a bin.
 *
 * The description is the full path, not the bin's own name: "A-01" appears in
 * every warehouse, and the thing that tells two of them apart is what they sit
 * under.
 */
export function BinPicker({ value, onChange, error, label = 'Bin' }: PickerProps<Location>) {
  const [query, setQuery] = useState('');
  const search = useBinSearch(useDebounced(query));

  return (
    <SearchPicker
      label={label}
      placeholder="Search bin code or name"
      value={value}
      onChange={onChange}
      options={search.data?.data ?? []}
      isLoading={search.isLoading}
      getKey={(location) => location.id}
      getLabel={(location) => location.code}
      getDescription={(location) => location.pathLabel}
      query={query}
      onQueryChange={setQuery}
      error={error}
      emptyText={query ? 'No bin matches that' : 'No bins yet'}
    />
  );
}
