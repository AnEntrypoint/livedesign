import { useMemo } from 'react';
import { announceLocationChange, navigate, useAppPathname, useAppSearchParams } from './router-store';

export interface NavigateOptions {
  scroll?: boolean;
}

export interface AppRouterInstance {
  push(href: string, options?: NavigateOptions): void;
  replace(href: string, options?: NavigateOptions): void;
  back(): void;
  forward(): void;
  refresh(): void;
  prefetch(href: string): void;
}

const router: AppRouterInstance = {
  push: (href) => navigate(href, 'push'),
  replace: (href) => navigate(href, 'replace'),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  refresh: () => announceLocationChange(),
  prefetch: () => undefined,
};

export function useRouter(): AppRouterInstance {
  return router;
}

export function usePathname(): string {
  return useAppPathname();
}

export function useSearchParams(): URLSearchParams {
  return useAppSearchParams();
}

export function useParams<T extends Record<string, string | string[]> = Record<string, string | string[]>>(): T {
  return useMemo(() => ({}) as T, []);
}

export function useSelectedLayoutSegment(): string | null {
  return null;
}

export function useSelectedLayoutSegments(): string[] {
  return [];
}

export function redirect(href: string): never {
  throw new Error(
    `next/navigation redirect("${href}") is a server-side Next.js feature and cannot run in this Vite client app. Use useRouter().push("${href}") instead.`,
  );
}

export function permanentRedirect(href: string): never {
  throw new Error(
    `next/navigation permanentRedirect("${href}") is a server-side Next.js feature and cannot run in this Vite client app. Use useRouter().replace("${href}") instead.`,
  );
}

export function notFound(): never {
  throw new Error(
    'next/navigation notFound() is a server-side Next.js feature and cannot run in this Vite client app. Render your own not-found UI instead.',
  );
}
