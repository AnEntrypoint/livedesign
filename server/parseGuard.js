const MAX_BRACKET_DEPTH = 1500;
const MAX_JSX_DEPTH = 1500;
const MAX_REPEATED_WORD_RUN = 200;

const OPENING = new Set(['(', '[', '{']);
const CLOSING = new Set([')', ']', '}']);
const TEMPLATE_TEXT = 'T';
const TEMPLATE_EXPRESSION = '$';
const WORD_CHARACTER = /[A-Za-z0-9_$]/;
const WHITESPACE = /\s/;
const TAG_START = /[A-Za-z_$>]/;
const EXPRESSION_END = /[A-Za-z0-9_$)\]]/;

function skipLineComment(code, index) {
  const end = code.indexOf('\n', index);
  return end === -1 ? code.length : end;
}

function skipBlockComment(code, index) {
  const end = code.indexOf('*/', index + 2);
  return end === -1 ? code.length : end + 2;
}

function skipQuoted(code, index) {
  const quote = code[index];
  let cursor = index + 1;
  while (cursor < code.length) {
    const character = code[cursor];
    if (character === '\\') cursor += 2;
    else if (character === quote || character === '\n') return cursor + 1;
    else cursor += 1;
  }
  return code.length;
}

export function complexityViolation(code) {
  const stack = [];
  let jsxDepth = 0;
  let previousSignificant = '';
  let previousWord = '';
  let wordRun = 0;
  let onlySpaceSincePreviousWord = false;
  let index = 0;
  while (index < code.length) {
    const character = code[index];
    if (stack[stack.length - 1] === TEMPLATE_TEXT) {
      if (character === '\\') index += 2;
      else if (character === '`') {
        stack.pop();
        previousSignificant = 'a';
        index += 1;
      } else if (character === '$' && code[index + 1] === '{') {
        stack.push(TEMPLATE_EXPRESSION);
        if (stack.length > MAX_BRACKET_DEPTH) return 'bracket_nesting';
        index += 2;
      } else index += 1;
      continue;
    }
    if (character === '/' && code[index + 1] === '/') {
      index = skipLineComment(code, index);
      continue;
    }
    if (character === '/' && code[index + 1] === '*') {
      index = skipBlockComment(code, index);
      continue;
    }
    if (character === '"' || character === "'") {
      index = skipQuoted(code, index);
      previousSignificant = '"';
      onlySpaceSincePreviousWord = false;
      continue;
    }
    if (WORD_CHARACTER.test(character)) {
      let end = index + 1;
      while (end < code.length && WORD_CHARACTER.test(code[end])) end += 1;
      const word = code.slice(index, end);
      wordRun = onlySpaceSincePreviousWord && word === previousWord ? wordRun + 1 : 1;
      if (wordRun > MAX_REPEATED_WORD_RUN) return 'repeated_token_run';
      previousWord = word;
      onlySpaceSincePreviousWord = true;
      previousSignificant = 'a';
      index = end;
      continue;
    }
    if (WHITESPACE.test(character)) {
      index += 1;
      continue;
    }
    onlySpaceSincePreviousWord = false;
    if (character === '`') {
      stack.push(TEMPLATE_TEXT);
      if (stack.length > MAX_BRACKET_DEPTH) return 'bracket_nesting';
    } else if (OPENING.has(character)) {
      stack.push(character);
      if (stack.length > MAX_BRACKET_DEPTH) return 'bracket_nesting';
    } else if (CLOSING.has(character)) {
      stack.pop();
    } else if (character === '<') {
      const next = code[index + 1] ?? '';
      if (next === '/') {
        jsxDepth = Math.max(0, jsxDepth - 1);
      } else if (TAG_START.test(next) && !EXPRESSION_END.test(previousSignificant)) {
        jsxDepth += 1;
        if (jsxDepth > MAX_JSX_DEPTH) return 'jsx_nesting';
      }
    } else if (character === '/' && code[index + 1] === '>') {
      jsxDepth = Math.max(0, jsxDepth - 1);
    }
    previousSignificant = character;
    index += 1;
  }
  return null;
}
