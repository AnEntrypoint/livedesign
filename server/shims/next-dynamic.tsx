import { Suspense, lazy, useEffect, useState, type ComponentType, type JSX, type ReactNode } from 'react';

type LoadedComponent<P> = ComponentType<P> | { default: ComponentType<P> };

export interface DynamicOptions {
  ssr?: boolean;
  loading?: ComponentType<{ isLoading: boolean; pastDelay: boolean; error: null }> | (() => ReactNode);
}

function toModule<P>(loaded: LoadedComponent<P>): { default: ComponentType<P> } {
  return 'default' in loaded ? loaded : { default: loaded };
}

function useHasMounted(): boolean {
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => setHasMounted(true), []);
  return hasMounted;
}

export default function dynamic<P extends object = object>(
  loader: () => Promise<LoadedComponent<P>>,
  options: DynamicOptions = {},
): ComponentType<P> {
  const { ssr = true, loading: Loading } = options;
  const LazyComponent = lazy(async () => toModule(await loader()));

  function DynamicComponent(props: P): JSX.Element | null {
    const hasMounted = useHasMounted();
    const fallback = Loading ? <Loading isLoading pastDelay error={null} /> : null;
    if (!ssr && !hasMounted) return fallback;
    return (
      <Suspense fallback={fallback}>
        <LazyComponent {...(props as P & JSX.IntrinsicAttributes)} />
      </Suspense>
    );
  }

  return DynamicComponent;
}
