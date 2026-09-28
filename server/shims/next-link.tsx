import { forwardRef, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import { isInternalHref, navigate } from './router-store';

export interface UrlObject {
  pathname?: string | null;
  query?: Record<string, string | number | boolean | readonly string[] | null | undefined> | string | null;
  hash?: string | null;
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string | UrlObject;
  as?: string | UrlObject;
  replace?: boolean;
  scroll?: boolean;
  shallow?: boolean;
  prefetch?: boolean | null;
  passHref?: boolean;
  legacyBehavior?: boolean;
  locale?: string | false;
}

function formatQuery(query: UrlObject['query']): string {
  if (!query) return '';
  if (typeof query === 'string') return query.startsWith('?') ? query : `?${query}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

function formatHref(href: string | UrlObject): string {
  if (typeof href === 'string') return href;
  const hash = href.hash ? (href.hash.startsWith('#') ? href.hash : `#${href.hash}`) : '';
  return `${href.pathname ?? ''}${formatQuery(href.query)}${hash}`;
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, as: _as, replace, scroll: _scroll, shallow: _shallow, prefetch: _prefetch, passHref: _passHref, legacyBehavior: _legacyBehavior, locale: _locale, onClick, target, children, ...anchorProps },
  ref,
) {
  const destination = formatHref(href);

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    const opensInSameTab = !target || target === '_self';
    if (event.defaultPrevented || !opensInSameTab || anchorProps.download !== undefined) return;
    if (!isPlainLeftClick(event) || !isInternalHref(destination)) return;
    event.preventDefault();
    navigate(destination, replace ? 'replace' : 'push');
  }

  return (
    <a {...anchorProps} ref={ref} href={destination} target={target} onClick={handleClick}>
      {children}
    </a>
  );
});

export default Link;
