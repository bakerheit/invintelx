import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { NEGATIVE_STOCK_EXPLANATION } from './warnings';

/** One operation's form, boxed and titled. */
export function FormCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4 sm:p-6">
      <h2 className="font-medium">{title}</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/**
 * The bin would go negative.
 *
 * Amber, not red, and nowhere near the submit button's disabled state: this is
 * the screen telling somebody what their entry will do, not standing in its way.
 */
export function NegativeStockNotice({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="flex gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div>
        <p className="font-medium">{message}</p>
        <p className="mt-0.5 text-muted-foreground">{NEGATIVE_STOCK_EXPLANATION}</p>
      </div>
    </div>
  );
}

/**
 * What the write did, and where it left the balance.
 *
 * The whole point of the section: somebody posts a movement and sees the number
 * it produced, rather than being told "saved" and going to look it up.
 */
export function PostedResult({ summary, balances }: { summary: string; balances: string[] }) {
  return (
    <div
      role="status"
      className="flex gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm"
    >
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      <div>
        <p className="font-medium">{summary}</p>
        {balances.map((balance) => (
          <p key={balance} className="tabular mt-0.5 text-muted-foreground">
            {balance}
          </p>
        ))}
      </div>
    </div>
  );
}

/** A rejected write, said once, above the submit button. */
export function FormError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </p>
  );
}
