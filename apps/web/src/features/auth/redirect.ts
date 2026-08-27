/**
 * Where a signed-in user lands when there is nowhere better to send them.
 */
export const DEFAULT_REDIRECT = '/items';

/** Space and every control character below it. */
const HIGHEST_STRIPPED_CODE = 0x20;
/** DEL, which browsers drop from a URL the same way. */
const DELETE_CODE = 0x7f;

/*
 * Browsers strip control characters and spaces out of a URL before resolving
 * it, rather than treating them as part of the path. A single tab is therefore
 * enough to walk a hostile string past a naive "starts with a slash" check and
 * still land off-site: "/", tab, "/evil.example" reads as a one-slash path here
 * and resolves as protocol-relative there.
 *
 * Such a value is refused outright rather than stripped and re-examined. A
 * destination inside this app never contains one, because the pathname and
 * search react-router hands us are already percent-encoded.
 */
function containsStrippedCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= HIGHEST_STRIPPED_CODE || code === DELETE_CODE) return true;
  }
  return false;
}

/**
 * Whether a return-to destination is a path inside this app.
 *
 * Today the only producer is ProtectedRoute, which builds the value out of the
 * app's own `location`, so nothing hostile can reach here. That is safety by
 * construction, and it stops being true the moment somebody accepts the
 * destination from a query parameter or an emailed link — which is exactly the
 * change that gets made without noticing the assumption underneath it. So the
 * rule is stated once, here, and every redirect goes through it.
 *
 * Accepted: a single leading slash, i.e. a path relative to this origin.
 * Refused, among everything else:
 *   - "//evil.example", which is protocol-relative and leaves the origin;
 *   - "/\evil.example", which several browsers normalise to the same thing;
 *   - "https://evil.example" and "javascript:...", which are not paths at all;
 *   - "evil.example", a bare relative path — harmless in itself, but it resolves
 *     against wherever the user happens to be, so where it lands is not knowable
 *     from the value alone.
 */
export function isSafeRedirect(target: unknown): target is string {
  if (typeof target !== 'string') return false;
  if (containsStrippedCharacter(target)) return false;
  if (!target.startsWith('/')) return false;
  // One slash and no more. The second character is what decides whether the
  // rest of the string is a path on this origin or the host of another one.
  if (target[1] === '/' || target[1] === '\\') return false;
  return true;
}

/**
 * The destination to actually navigate to: `target` when it is a path inside
 * this app, and the fallback otherwise. Callers should not test the destination
 * themselves — passing it through here is the whole point.
 */
export function safeRedirect(target: unknown, fallback: string = DEFAULT_REDIRECT): string {
  if (isSafeRedirect(target)) return target;
  /*
   * The fallback is a literal at every call site today, but the contract here is
   * that what comes out is a path inside this app — with no exception carved out
   * for the argument that currently happens to be trustworthy.
   */
  return isSafeRedirect(fallback) ? fallback : DEFAULT_REDIRECT;
}
