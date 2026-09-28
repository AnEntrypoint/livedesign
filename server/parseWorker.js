import { parseAst } from 'vite';
import { specifiersOfProgram } from './programSpecifiers.js';

const MAX_MESSAGE_CHARS = 2000;

function outcomeOf(operation, code, language) {
  try {
    const program = parseAst(code, { lang: language });
    return operation === 'specifiers' ? { ok: true, specifiers: specifiersOfProgram(program) } : { ok: true };
  } catch (error) {
    return { ok: false, message: String(error.message).slice(0, MAX_MESSAGE_CHARS), pos: Number.isInteger(error.pos) ? error.pos : null };
  }
}

process.on('message', ({ id, operation, code, language }) => {
  process.send({ id, result: outcomeOf(operation, code, language) });
});

process.on('disconnect', () => process.exit(0));
