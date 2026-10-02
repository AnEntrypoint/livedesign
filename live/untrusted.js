const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}ᅟᅠㅤﾠ⠀]/gu;
const CONTROL_SINGLE_LINE = /\p{Cc}+/gu;
const CONTROL_MULTI_LINE = /(?![\n\t])\p{Cc}/gu;
const NON_ASCII = /[^\x20-\x7e\n\t]/g;
const DASH_RUN = /[-‐-―−─-╿⸺⸻﹘﹣－]{3,}/g;
const ROLE_PREFIX = /\b(system|assistant|user|model|developer|human|tool|function)\s*[:>]/gi;
const SEPARATOR = '[^a-z0-9]{0,3}';
const spelled = (words) => new RegExp(words.map((word) => [...word].join(SEPARATOR)).join(`${SEPARATOR}\\s*${SEPARATOR}`), 'gi');
const MARKERS = [spelled(['system', 'notice']), spelled(['untrusted', 'app', 'output']), spelled(['begin', 'untrusted']), spelled(['end', 'untrusted'])];

function scrub(value, { multiline, asciiOnly }) {
  let text = String(value ?? '').normalize('NFKC').replace(INVISIBLE, '');
  text = text.replace(multiline ? CONTROL_MULTI_LINE : CONTROL_SINGLE_LINE, ' ');
  text = text.replace(DASH_RUN, '-');
  if (asciiOnly) text = text.replace(NON_ASCII, '?');
  for (const marker of MARKERS) text = text.replace(marker, '[filtered]');
  text = text.replace(ROLE_PREFIX, '$1 -');
  return multiline
    ? text.replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : text.replace(/\s+/g, ' ').trim();
}

export function neutraliseLine(value, limit, { asciiOnly = false } = {}) {
  return scrub(value, { multiline: false, asciiOnly }).slice(0, limit);
}

export function neutraliseBlock(value, limit, { asciiOnly = false } = {}) {
  return scrub(value, { multiline: true, asciiOnly }).slice(0, limit);
}
