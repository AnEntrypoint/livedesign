import { languageOf } from './parseLanguage.js';
import { parseSafely } from './safeParse.js';

export async function moduleSpecifiersOf(code, filePath) {
  const language = languageOf(filePath);
  if (!language) return [];
  const parsed = await parseSafely(code, language, 'specifiers');
  return parsed.ok ? parsed.specifiers : [];
}
