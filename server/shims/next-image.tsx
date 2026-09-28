import { forwardRef, type CSSProperties, type ImgHTMLAttributes } from 'react';

export interface StaticImageData {
  src: string;
  height: number;
  width: number;
  blurDataURL?: string;
}

type Dimension = number | `${number}`;

export interface ImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'width' | 'height' | 'alt'> {
  src: string | StaticImageData;
  alt: string;
  width?: Dimension;
  height?: Dimension;
  fill?: boolean;
  priority?: boolean;
  placeholder?: 'blur' | 'empty' | `data:image/${string}`;
  blurDataURL?: string;
  quality?: number | `${number}`;
  unoptimized?: boolean;
  overrideSrc?: string;
  loader?: unknown;
  onLoadingComplete?: unknown;
  lazyBoundary?: string;
  lazyRoot?: string;
}

const FILL_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
};

const Image = forwardRef<HTMLImageElement, ImageProps>(function Image(
  {
    src,
    alt,
    width,
    height,
    fill,
    style,
    priority: _priority,
    placeholder: _placeholder,
    blurDataURL: _blurDataURL,
    quality: _quality,
    unoptimized: _unoptimized,
    overrideSrc: _overrideSrc,
    loader: _loader,
    onLoadingComplete: _onLoadingComplete,
    lazyBoundary: _lazyBoundary,
    lazyRoot: _lazyRoot,
    ...imgProps
  },
  ref,
) {
  const resolvedSrc = typeof src === 'string' ? src : src.src;
  const intrinsic = typeof src === 'string' ? undefined : src;
  const resolvedWidth = fill ? undefined : (width ?? intrinsic?.width);
  const resolvedHeight = fill ? undefined : (height ?? intrinsic?.height);

  return (
    <img
      {...imgProps}
      ref={ref}
      src={resolvedSrc}
      alt={alt}
      width={resolvedWidth}
      height={resolvedHeight}
      decoding="async"
      style={fill ? { ...FILL_STYLE, ...style } : style}
    />
  );
});

export default Image;
