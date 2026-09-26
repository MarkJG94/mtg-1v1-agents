import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from 'react';

/**
 * A history router the size of this app: four kinds of page, matched by hand. The server
 * answers `index.html` for any path that is not the API's (apps/server app.ts), so a
 * reload or a pasted link lands on the right page.
 */

export type Route =
  | { readonly page: 'runs' }
  | { readonly page: 'newRun' }
  | { readonly page: 'run'; readonly runId: string }
  | { readonly page: 'notFound'; readonly path: string };

export const matchRoute = (pathname: string): Route => {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/runs') return { page: 'runs' };
  if (path === '/runs/new') return { page: 'newRun' };
  const run = /^\/runs\/([^/]+)$/.exec(path);
  if (run?.[1] !== undefined) {
    try {
      return { page: 'run', runId: decodeURIComponent(run[1]) };
    } catch {
      // A malformed escape is no run's id.
    }
  }
  return { page: 'notFound', path };
};

export const runPath = (runId: string) => `/runs/${encodeURIComponent(runId)}`;

const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener('popstate', notify);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('popstate', notify);
  };
};

export const navigate = (to: string, options: { replace?: boolean } = {}) => {
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  notify();
};

/** The current path, re-rendering on `navigate` and the browser's back and forward. */
export const usePathname = (): string =>
  useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => '/',
  );

export const useRoute = (): Route => matchRoute(usePathname());

/** A link that navigates in place, leaving a modified or middle click to the browser. */
export const Link = ({
  to,
  onClick,
  ...rest
}: { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) => (
  <a
    {...rest}
    href={to}
    onClick={(event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      navigate(to);
    }}
  />
);
