#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [];
for (const directory of ['src', 'scripts', 'test']) {
  for (const entry of await readdir(path.join(root, directory), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(path.join(entry.parentPath, entry.name));
  }
}
let failures = 0;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    failures++;
    process.stderr.write(`Syntax check failed: ${path.relative(root, file)}\n${result.stderr || result.error?.message || ''}\n`);
  }
}
for (const file of ['package.json', 'package-lock.json', 'examples/mcp.example.json']) {
  try { JSON.parse(await readFile(path.join(root, file), 'utf8')); }
  catch (error) { failures++; process.stderr.write(`JSON check failed: ${file}: ${error.message}\n`); }
}
console.log(JSON.stringify({ javascriptFiles: files.length, jsonFiles: 3, failures }));
process.exitCode = failures ? 1 : 0;
