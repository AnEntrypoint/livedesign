import { specifiersOfProgram } from './programSpecifiers.js';

const MAX_MESSAGE_CHARS = 2000;
const MAX_SYNTAX_TREE_DEPTH = 1500;
const IDLE_EXIT_MS = Number(process.env.HMR_PARSE_IDLE_MS) || 10 * 60 * 1000;
const OWNER_SILENCE_EXIT_MS = 30000;
const WARM_UP_SOURCE = 'export default function Warm() { return <div>{1}</div>; }';
const TRANSFORM_OPTIONS = { jsx: { runtime: 'automatic', development: true, refresh: true }, sourcemap: false };

let idleTimer = null;
let ownerTimer = null;
let parseAst;
let transformSync;

function armIdleExit() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
}

function armOwnerExit() {
  clearTimeout(ownerTimer);
  ownerTimer = setTimeout(() => process.exit(0), OWNER_SILENCE_EXIT_MS);
}

function syntaxTreeDepth(program) {
  let deepest = 0;
  const pending = [[program, 0]];
  while (pending.length > 0) {
    const [node, depth] = pending.pop();
    if (node === null || typeof node !== 'object') continue;
    const isNode = !Array.isArray(node);
    const nextDepth = isNode ? depth + 1 : depth;
    if (nextDepth > deepest) deepest = nextDepth;
    if (deepest > MAX_SYNTAX_TREE_DEPTH) return deepest;
    for (const child of Object.values(node)) {
      if (child !== null && typeof child === 'object') pending.push([child, nextDepth]);
    }
  }
  return deepest;
}

function outcomeOfSync(operation, code, language) {
  let program;
  try {
    program = parseAst(code, { lang: language });
  } catch (error) {
    return { ok: false, message: String(error.message).slice(0, MAX_MESSAGE_CHARS), pos: Number.isInteger(error.pos) ? error.pos : null };
  }
  if (syntaxTreeDepth(program) > MAX_SYNTAX_TREE_DEPTH) return { crashed: true, reason: 'too_deep' };
  if (operation === 'specifiers') return { ok: true, specifiers: specifiersOfProgram(program) };
  const transformed = transformSync(`module.${language}`, code, { lang: language, ...TRANSFORM_OPTIONS });
  if (transformed.errors.length > 0) return { ok: false, message: String(transformed.errors[0].message).slice(0, MAX_MESSAGE_CHARS), pos: null };
  return { ok: true };
}

async function loadCompiler() {
  ({ parseAst } = await import('rolldown/parseAst'));
  ({ transformSync } = await import('rolldown/utils'));
}

process.on('message', ({ id, operation, code, language, ping, retire }) => {
  if (retire === true) process.exit(0);
  if (ping === true) {
    armOwnerExit();
    return;
  }
  armIdleExit();
  process.send({ id, result: outcomeOfSync(operation, code, language) });
  armIdleExit();
});

process.on('disconnect', () => process.exit(0));
await loadCompiler();
outcomeOfSync('check', WARM_UP_SOURCE, 'tsx');
armIdleExit();
armOwnerExit();
process.send({ ready: true });
