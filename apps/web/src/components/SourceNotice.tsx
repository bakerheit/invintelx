/**
 * AGPL section 13 requires a network-interactive program to offer its users
 * access to the Corresponding Source. That is a property of the running
 * application, not of a LICENSE file sitting in a repository, so it lives here
 * and renders wherever a user can reach the app.
 *
 * The URL is configurable because a downstream fork has to point at *its* own
 * modified source to be compliant, not at ours. Hardcoding our repository would
 * quietly make every modified deployment non-compliant.
 */
const SOURCE_URL =
  import.meta.env.VITE_SOURCE_URL ?? 'https://github.com/bakerheit/invintelx';

export function SourceNotice({ className }: { className?: string }) {
  return (
    <p className={className}>
      <a
        href="https://www.gnu.org/licenses/agpl-3.0.html"
        target="_blank"
        rel="noreferrer noopener"
        className="hover:text-foreground hover:underline"
      >
        AGPL-3.0
      </a>
      {' · '}
      <a
        href={SOURCE_URL}
        target="_blank"
        rel="noreferrer noopener"
        className="hover:text-foreground hover:underline"
      >
        Source
      </a>
    </p>
  );
}
