#!/usr/bin/env node
/**
 * Ensures the `roles` checkboxes in GitHub Issue Forms stay in sync with
 * `ROLES` in src/lib/taxonomy.ts (the single source of truth).
 *
 * Usage:
 *   node scripts/sync-issue-templates.mjs          # check only (exits 1 if out of sync)
 *   node scripts/sync-issue-templates.mjs --write  # update YAML templates in place
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROLES } from '../src/lib/taxonomy.ts';

const writeMode = process.argv.includes('--write');
const TEMPLATES = ['.github/ISSUE_TEMPLATE/propose-article.yml'];

const expectedBlock = Object.values(ROLES)
  .map((role) => `        - label: ${role.label}`)
  .join('\n');

// Matches the `options:` list inside the `id: roles` checkboxes item.
const ROLES_OPTIONS_RE =
  /(-\s+type:\s+checkboxes\r?\n\s+id:\s+roles[\s\S]*?\r?\n\s+options:\r?\n)((?:\s+-\s+label:\s+.+\r?\n?)+)/;

let outOfSync = false;

for (const relPath of TEMPLATES) {
  const fullPath = path.resolve(relPath);
  const current = readFileSync(fullPath, 'utf8');
  const match = ROLES_OPTIONS_RE.exec(current);

  if (!match) {
    console.error(`✗ Could not find 'id: roles' checkboxes block in ${relPath}`);
    process.exit(1);
  }

  const existingOptions = match[2].replace(/\r\n/g, '\n').trimEnd();
  if (existingOptions !== expectedBlock) {
    if (writeMode) {
      const updated =
        current.slice(0, match.index) +
        match[1] +
        expectedBlock +
        '\n' +
        current.slice(match.index + match[0].length).replace(/^\r?\n/, '');
      writeFileSync(fullPath, updated, 'utf8');
      console.log(`✓ Updated roles in ${relPath}`);
    } else {
      outOfSync = true;
      console.error(`✗ Roles in ${relPath} do not match src/lib/taxonomy.ts.`);
    }
  }
}

if (outOfSync) {
  console.error('\nRun `npm run sync:roles` to update the GitHub issue templates from src/lib/taxonomy.ts.\n');
  process.exit(1);
}

if (!writeMode) {
  console.log('✓ Issue template roles match src/lib/taxonomy.ts.');
}
