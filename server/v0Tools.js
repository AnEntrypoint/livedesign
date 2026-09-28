import fs from 'node:fs';
import { Type } from '@google/genai';
import { LIMITS, WRITABLE_EXTENSIONS } from './config.js';
import { ToolError } from './errors.js';
import { sandboxed } from './paths.js';
import { writeAtomically } from './atomicWrite.js';
import { beginChange } from './guard.js';
import { settleChange } from './settle.js';
import * as v0 from './v0.js';
import { resolveLocalImports, withoutExtension } from './shadcn.js';
import path from 'node:path';

const ALWAYS_REPLACED = new Set(['app/page.tsx', 'app/globals.css']);

const templateId = { type: Type.STRING, description: 'Template id from v0_search results.' };

export const v0Declarations = [
  {
    name: 'v0_categories',
    description: 'List the v0.app community template categories. Pass a slug as category to v0_search.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'v0_search',
    description: 'Search community templates on v0.app. Use it first when the user wants to build something, then inspect a result with v0_template. Without query it lists the most used templates; sort random gives inspiration.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Words to match against title, tags, description and category, for example "crm dashboard dark".' },
        category: { type: Type.STRING, description: 'Category slug from v0_categories to search within.' },
        tag: { type: Type.STRING, description: 'Only templates with a tag containing this text.' },
        sort: { type: Type.STRING, description: 'relevance (default with query), popular (default without), likes, recent or random.' },
        limit: { type: Type.INTEGER, description: 'Number of results, default 6, at most 20.' },
      },
    },
  },
  {
    name: 'v0_template',
    description: 'Inspect one template: description, tags, live demo URL, the list of source files with sizes, and which npm packages it needs and which of those are not installed here.',
    parameters: { type: Type.OBJECT, properties: { id: templateId }, required: ['id'] },
  },
  {
    name: 'v0_read_file',
    description: 'Read the source of one file of a template, path exactly as listed by v0_template.',
    parameters: {
      type: Type.OBJECT,
      properties: { id: templateId, path: { type: Type.STRING, description: 'File path inside the template, for example "app/page.tsx".' } },
      required: ['id', 'path'],
    },
  },
  {
    name: 'add_ui_component',
    description: 'Add shadcn/ui components to app/components/ui from the public shadcn registry, with their dependencies, for example ["dialog", "tabs"]. Use it when an import of @/components/ui/<name> cannot be resolved.',
    parameters: {
      type: Type.OBJECT,
      properties: { names: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Component names such as "card", "dialog", "data-table".' } },
      required: ['names'],
    },
  },
  {
    name: 'v0_import',
    description: 'Copy a template into app/ (template paths map one to one). app/page.tsx and app/globals.css are always replaced; other files that already exist are skipped unless overwrite is true. Config, layout and server-only files are skipped. Reports written, skipped, missing packages and the real app status. Use restore_last_good to undo.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: templateId,
        paths: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Only import these template paths. Default: all source files.' },
        overwrite: { type: Type.BOOLEAN, description: 'Also replace existing shared files such as components/ui/*. Default false.' },
      },
      required: ['id'],
    },
  },
];

async function plansForSuppliedFiles(files) {
  const supplied = [];
  for (const { relative, content } of files) {
    const target = sandboxed(relative);
    if (!fs.existsSync(target.absolute)) supplied.push({ ...target, content, exists: false });
  }
  return supplied;
}

function planImport(detail, args) {
  const wanted = Array.isArray(args.paths) && args.paths.length > 0 ? new Set(args.paths) : null;
  if (wanted) {
    const known = new Set(detail.files.map((file) => file.path));
    for (const requested of wanted) {
      if (!known.has(requested)) throw new ToolError('unknown_path', `template has no file "${requested}"`);
    }
  }
  const overwrite = args.overwrite === true;
  const plan = [];
  const skipped = [];
  for (const file of detail.files) {
    if (wanted && !wanted.has(file.path)) continue;
    const reason = v0.skipReason(file.path);
    if (reason) {
      skipped.push({ path: file.path, reason });
      continue;
    }
    let target;
    try {
      target = sandboxed(file.path);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      skipped.push({ path: file.path, reason: error.message });
      continue;
    }
    if (!WRITABLE_EXTENSIONS.has(path.extname(target.absolute).toLowerCase())) {
      skipped.push({ path: file.path, reason: 'file type is not writable through the sandbox' });
      continue;
    }
    if (Buffer.byteLength(file.content, 'utf8') > LIMITS.maxFileBytes) {
      skipped.push({ path: file.path, reason: 'file is larger than the size limit' });
      continue;
    }
    const exists = fs.existsSync(target.absolute);
    if (exists && !overwrite && !ALWAYS_REPLACED.has(target.relative)) {
      skipped.push({ path: file.path, reason: 'already exists, pass overwrite to replace it' });
      continue;
    }
    plan.push({ ...target, content: file.content, exists });
  }
  const totalBytes = plan.reduce((sum, item) => sum + Buffer.byteLength(item.content, 'utf8'), 0);
  if (plan.length > LIMITS.v0ImportMaxFiles || totalBytes > LIMITS.v0ImportMaxBytes) {
    throw new ToolError('import_too_large', `import would write ${plan.length} files and ${totalBytes} bytes; pass paths to import a subset`);
  }
  return { plan, skipped };
}

export const v0Handlers = {
  async v0_categories() {
    return { ok: true, categories: await v0.categories() };
  },

  async v0_search(args) {
    return { ok: true, ...await v0.search({ query: args.query, category: args.category, tag: args.tag, sort: args.sort, limit: args.limit }) };
  },

  async v0_template(args) {
    return { ok: true, ...await v0.describeTemplate(args.id) };
  },

  async v0_read_file(args) {
    if (typeof args.path !== 'string') throw new ToolError('invalid_argument', 'path must be a string');
    return { ok: true, ...await v0.readTemplateFile(args.id, args.path) };
  },

  async v0_import(args, context) {
    const detail = await v0.loadTemplate(args.id);
    const { plan, skipped } = planImport(detail, args);
    if (plan.length === 0) return { ok: true, template: args.id, written: [], skipped, note: 'Nothing to write.' };
    const local = await resolveLocalImports({ sources: plan.map((item) => item.content), planned: new Set(plan.map((item) => withoutExtension(item.relative))) });
    const supplied = await plansForSuppliedFiles(local.added);
    const change = beginChange();
    for (const item of [...plan, ...supplied]) await writeAtomically(item.absolute, item.content);
    const imports = v0.importsOf(plan.map((item) => ({ content: item.content })));
    return {
      ok: true,
      template: args.id,
      title: detail.title,
      written: plan.map((item) => item.relative),
      overwritten: plan.filter((item) => item.exists).map((item) => item.relative),
      addedFromShadcn: supplied.map((item) => item.relative),
      skipped,
      missingPackages: [...new Set([...imports.missing, ...local.missingPackages])].sort(),
      unresolvedImports: local.unresolved,
      unsupportedNextImports: imports.unsupportedNext,
      ...await settleChange(context.server, { changedPaths: [...plan, ...supplied].map((item) => item.relative), ...change }),
    };
  },

  async add_ui_component(args, context) {
    if (!Array.isArray(args.names) || args.names.length === 0 || !args.names.every((name) => typeof name === 'string')) {
      throw new ToolError('invalid_argument', 'names must be a non-empty array of shadcn component names such as "dialog"');
    }
    const local = await resolveLocalImports({ sources: args.names.map((name) => `import x from "@/components/ui/${name}"`), planned: new Set() });
    const supplied = await plansForSuppliedFiles(local.added);
    if (supplied.length === 0) return { ok: true, added: [], unresolvedImports: local.unresolved, note: 'Everything requested already exists or is not a shadcn component.' };
    const change = beginChange();
    for (const item of supplied) await writeAtomically(item.absolute, item.content);
    return {
      ok: true,
      added: supplied.map((item) => item.relative),
      unresolvedImports: local.unresolved,
      missingPackages: local.missingPackages,
      ...await settleChange(context.server, { changedPaths: supplied.map((item) => item.relative), ...change }),
    };
  },
};
