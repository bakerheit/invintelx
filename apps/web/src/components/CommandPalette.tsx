import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/AuthProvider';
import { NAV_ITEMS } from './nav';
import { cn } from '@/lib/utils';

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();
  const { user } = useAuth();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // Same rule as the sidebar: nothing offers to take you somewhere that will
    // refuse you when you get there.
    const available = NAV_ITEMS.filter(
      (item) => !item.planned && (!item.adminOnly || user?.role === 'admin'),
    );
    if (!needle) return available;
    return available.filter((item) => item.label.toLowerCase().includes(needle));
  }, [query, user?.role]);

  // A stale index after filtering would highlight a row that is no longer there.
  useEffect(() => setActiveIndex(0), [query]);

  const go = (to: string) => {
    setOpen(false);
    setQuery('');
    navigate(to);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[20%] max-w-md translate-y-0 gap-0 p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Jump to a section of InvIntelX</DialogDescription>

        <div className="border-b border-border p-2">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, results.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const target = results[activeIndex];
                if (target) go(target.to);
              }
            }}
            placeholder="Jump to..."
            className="border-0 shadow-none focus-visible:ring-0"
          />
        </div>

        <ul className="max-h-72 overflow-y-auto p-2">
          {results.length === 0 && (
            <li className="px-2 py-6 text-center text-sm text-muted-foreground">No matches</li>
          )}
          {results.map((item, index) => (
            <li key={item.to}>
              <button
                type="button"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => go(item.to)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm',
                  index === activeIndex && 'bg-accent text-accent-foreground',
                )}
              >
                <item.icon className="h-4 w-4 text-muted-foreground" />
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
