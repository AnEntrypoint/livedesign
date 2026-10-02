const MAX_BRACKET_DEPTH = 1500;
const MAX_JSX_DEPTH = 1500;
const MAX_REPEATED_WORD_RUN = 200;
const MAX_AMBIGUOUS_FORKS = 16;

const OPENING = new Set(['(', '[', '{']);
const CLOSING = new Set([')', ']', '}']);
const BACKSLASH = String.fromCharCode(92);
const REGEX_PRECEDER = /[(,=:[!&|?{};+\-*%~^]/;
const DIVISION_OR_REGEX_PRECEDER = /[)\]]/;
const SIGNIFICANT_INSIDE_REGEX = /['"`<>()[\]{}]/;
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await']);
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
    if (character === BACKSLASH) cursor += 2;
    else if (character === quote) return cursor + 1;
    else if (character === '\n') return -1;
    else cursor += 1;
  }
  return -1;
}

function skipRegexLiteral(code, index) {
  let inClass = false;
  let cursor = index + 1;
  while (cursor < code.length) {
    const character = code[cursor];
    if (character === '\n') return -1;
    if (character === BACKSLASH) cursor += 2;
    else if (character === '[') {
      inClass = true;
      cursor += 1;
    } else if (character === ']') {
      inClass = false;
      cursor += 1;
    } else if (character === '/' && !inClass) {
      let end = cursor + 1;
      while (end < code.length && /[A-Za-z]/.test(code[end])) end += 1;
      return end;
    } else cursor += 1;
  }
  return -1;
}

function freshState() {
  return { stack: [], jsxDepth: 0, previousSignificant: '', previousWord: '', wordRun: 0, onlySpaceSincePreviousWord: false, index: 0 };
}

function forkedAfter(state, end) {
  return { ...state, stack: [...state.stack], index: end, previousSignificant: '"', onlySpaceSincePreviousWord: false };
}

function startsRegexForSure(state) {
  return state.previousSignificant === '' || REGEX_PRECEDER.test(state.previousSignificant) || (state.onlySpaceSincePreviousWord && REGEX_KEYWORDS.has(state.previousWord));
}

function scan(code, state, budget) {
  const { stack } = state;
  while (state.index < code.length) {
    const index = state.index;
    const character = code[index];
    if (stack[stack.length - 1] === TEMPLATE_TEXT) {
      if (character === BACKSLASH) state.index += 2;
      else if (character === '`') {
        stack.pop();
        state.previousSignificant = 'a';
        state.index += 1;
      } else if (character === '$' && code[index + 1] === '{') {
        stack.push(TEMPLATE_EXPRESSION);
        if (stack.length > MAX_BRACKET_DEPTH) return 'bracket_nesting';
        state.index += 2;
      } else state.index += 1;
      continue;
    }
    if (character === '/' && code[index + 1] === '/' && state.previousSignificant !== ':') {
      state.index = skipLineComment(code, index);
      continue;
    }
    if (character === '/' && code[index + 1] === '*') {
      state.index = skipBlockComment(code, index);
      continue;
    }
    if (character === '"' || character === "'") {
      const end = skipQuoted(code, index);
      if (end !== -1) {
        state.index = end;
        state.previousSignificant = '"';
        state.onlySpaceSincePreviousWord = false;
        continue;
      }
    }
    if (character === '/' && startsRegexForSure(state)) {
      const end = skipRegexLiteral(code, index);
      if (end !== -1) {
        state.index = end;
        state.previousSignificant = '"';
        state.onlySpaceSincePreviousWord = false;
        continue;
      }
    }
    if (character === '/' && DIVISION_OR_REGEX_PRECEDER.test(state.previousSignificant) && budget.forks > 0) {
      const end = skipRegexLiteral(code, index);
      if (end !== -1 && SIGNIFICANT_INSIDE_REGEX.test(code.slice(index, end))) {
        budget.forks -= 1;
        const found = scan(code, forkedAfter(state, end), budget);
        if (found !== null) return found;
      }
    }
    if (WORD_CHARACTER.test(character)) {
      let end = index + 1;
      while (end < code.length && WORD_CHARACTER.test(code[end])) end += 1;
      const word = code.slice(index, end);
      state.wordRun = state.onlySpaceSincePreviousWord && word === state.previousWord ? state.wordRun + 1 : 1;
      if (state.wordRun > MAX_REPEATED_WORD_RUN) return 'repeated_token_run';
      state.previousWord = word;
      state.onlySpaceSincePreviousWord = true;
      state.previousSignificant = 'a';
      state.index = end;
      continue;
    }
    if (WHITESPACE.test(character)) {
      state.index += 1;
      continue;
    }
    state.onlySpaceSincePreviousWord = false;
    if (character === ';' && stack.length === 0) state.jsxDepth = 0;
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
        state.jsxDepth = Math.max(0, state.jsxDepth - 1);
      } else if (TAG_START.test(next) && !EXPRESSION_END.test(state.previousSignificant)) {
        state.jsxDepth += 1;
        if (state.jsxDepth > MAX_JSX_DEPTH) return 'jsx_nesting';
      }
    } else if (character === '/' && code[index + 1] === '>') {
      state.jsxDepth = Math.max(0, state.jsxDepth - 1);
    }
    state.previousSignificant = character;
    state.index += 1;
  }
  return null;
}

export function complexityViolation(code) {
  return scan(code, freshState(), { forks: MAX_AMBIGUOUS_FORKS });
}
