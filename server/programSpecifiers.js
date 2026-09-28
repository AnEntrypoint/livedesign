const MODULE_REFERENCE_TYPES = new Set(['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression']);

function staticSourceOf(node) {
  if (node.importKind === 'type' || node.exportKind === 'type') return null;
  const source = node.source;
  const isReference = MODULE_REFERENCE_TYPES.has(node.type) && source?.type === 'Literal' && typeof source.value === 'string';
  return isReference ? source.value : null;
}

export function specifiersOfProgram(program) {
  const specifiers = [];
  const pending = [program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node) pending.push(child);
      continue;
    }
    const specifier = staticSourceOf(node);
    if (specifier !== null) specifiers.push(specifier);
    for (const child of Object.values(node)) {
      if (child !== null && typeof child === 'object') pending.push(child);
    }
  }
  return specifiers;
}
