export interface FontStub {
  className: string;
  variable: string;
  style: { fontFamily?: string; fontWeight?: number; fontStyle?: string };
}

function createFontStub(): FontStub {
  return { className: '', variable: '', style: {} };
}

export const fonts: Record<string, (options?: unknown) => FontStub> = new Proxy(
  {},
  { get: () => createFontStub },
);

export default function localFont(_options?: unknown): FontStub {
  return createFontStub();
}
