import { useMemo, useSyncExternalStore } from 'react';

const APP_BASE_PATH = '/app';
const LOCATION_CHANGED_EVENT = 'v0-compat:location-changed';

export type NavigationMode = 'push' | 'replace';

function stripAppBase(pathname: string): string {
  const withoutBase = pathname.startsWith(APP_BASE_PATH) ? pathname.slice(APP_BASE_PATH.length) : pathname;
  const withoutIndexFile = withoutBase.replace(/\/index\.html$/, '');
  return withoutIndexFile === '' ? '/' : withoutIndexFile;
}

function resolveDestination(href: string): URL {
  const rootRelative = href.startsWith('/') && !href.startsWith('//');
  return new URL(rootRelative ? APP_BASE_PATH + href : href, window.location.href);
}

export function isInternalHref(href: string): boolean {
  return (href.startsWith('/') && !href.startsWith('//')) || href.startsWith('?');
}

export function announceLocationChange(): void {
  window.dispatchEvent(new Event(LOCATION_CHANGED_EVENT));
}

export function navigate(href: string, mode: NavigationMode): void {
  const destination = resolveDestination(href);
  if (destination.origin !== window.location.origin) {
    window.location.assign(destination.href);
    return;
  }
  const target = destination.pathname + destination.search + destination.hash;
  if (mode === 'replace') window.history.replaceState(null, '', target);
  else window.history.pushState(null, '', target);
  announceLocationChange();
}

function subscribeToLocation(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(LOCATION_CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(LOCATION_CHANGED_EVENT, onChange);
  };
}

export function useAppPathname(): string {
  const pathname = useSyncExternalStore(subscribeToLocation, () => window.location.pathname);
  return stripAppBase(pathname);
}

export function useAppSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribeToLocation, () => window.location.search);
  return useMemo(() => new URLSearchParams(search), [search]);
}
