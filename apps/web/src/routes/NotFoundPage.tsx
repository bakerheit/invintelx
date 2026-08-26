import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-5xl font-semibold tracking-tight text-muted-foreground">404</p>
      <div>
        <h1 className="text-lg font-semibold">That page does not exist</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The link may be out of date, or the section may not be built yet.
        </p>
      </div>
      <Button asChild>
        <Link to="/items">Back to items</Link>
      </Button>
    </div>
  );
}
