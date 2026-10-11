#!/usr/bin/env node
/**
 * 审计图标匹配：找出可能匹配错的物品。
 *
 * 重点检查：
 *   1. 同一个文件名在包里有多个来源（跨命名空间/目录），我们选了哪一个；
 *   2. 匹配来源不是 slimefun 命名空间的（很可能是别的附属插件的同名贴图）；
 *   3. 走的是"模糊路径"或"别名规则"而不是精确文件名匹配的。
 *
 * 用法：node tools/audit-icons.mjs [资源包.zip]
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const packPath = process.argv[2]
  || 'E:/Minecraft/.minecraft/versions/DT-1.21.11-Fabric/resourcepacks/1.21.11粘液科技材质包.zip';

if (!existsSync(packPath)) {
  console.error(`资源包不存在：${packPath}`);
  process.exit(1);
}

const buffer = await readFile(packPath);
let eocd = -1;
for (let i = buffer.length - 22; i >= 0; i -= 1) {
  if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
const count = buffer.readUInt16LE(eocd + 10);
let p = buffer.readUInt32LE(eocd + 16);
const names = [];
for (let i = 0; i < count; i += 1) {
  const nameLen = buffer.readUInt16LE(p + 28);
  const extraLen = buffer.readUInt16LE(p + 30);
  const commentLen = buffer.readUInt16LE(p + 32);
  names.push(buffer.toString('utf8', p + 46, p + 46 + nameLen));
  p += 46 + nameLen + extraLen + commentLen;
}

const pngs = names.filter((name) => name.endsWith('.png'));
const byBase = new Map();
const byPath = new Map();
for (const name of pngs) {
  const base = name.split('/').pop().toLowerCase().replace(/\.png$/i, '');
  if (!byBase.has(base)) byBase.set(base, []);
  byBase.get(base).push(name);
  const match = name.match(/^assets\/([^/]+)\/textures\/(.+)$/);
  if (match) {
    const key = match[2].toLowerCase().replace(/\.png$/i, '');
    if (!byPath.has(key)) byPath.set(key, name);
  }
}

const items = (await readFile(join(root, 'data', 'recipes.core.jsonl'), 'utf8'))
  .split(/\r?\n/).filter(Boolean).slice(1).map((line) => JSON.parse(line));
const cache = existsSync(join(root, 'data', 'icons', 'icon-cache.json'))
  ? JSON.parse(await readFile(join(root, 'data', 'icons', 'icon-cache.json'), 'utf8'))
  : {};

const report = { ambiguous: [], crossNamespace: [], fuzzy: [], missing: [] };

for (const item of items) {
  const short = item.id.split(':').pop().toLowerCase();
  const cached = cache[item.id];
  if (!cached) {
    report.missing.push(item.id);
    continue;
  }

  const candidates = byBase.get(short) || [];
  const slimefunCandidate = candidates.find((name) => name.startsWith('assets/slimefun/'));
  const chosen = candidates[0];

  if (candidates.length > 1) {
    report.ambiguous.push({ id: item.id, candidates: candidates.map((name) => name.replace(/^assets\//, '')) });
  }
  if (chosen && !chosen.startsWith('assets/slimefun/')) {
    report.crossNamespace.push({
      id: item.id,
      chosen: chosen.replace(/^assets\//, ''),
      slimefunAlternative: slimefunCandidate ? slimefunCandidate.replace(/^assets\//, '') : null,
    });
  }
  if (candidates.length === 0) {
    report.fuzzy.push({ id: item.id, viaPath: byPath.get(short)?.replace(/^assets\//, '') || '(别名规则)' });
  }
}

console.log(`物品总数 ${items.length}；有图标 ${items.length - report.missing.length}；缺图标 ${report.missing.length}\n`);

console.log(`【1】同名文件有多处来源：${report.ambiguous.length} 个`);
for (const entry of report.ambiguous.slice(0, 15)) {
  console.log(`  ${entry.id}\n      ${entry.candidates.join('\n      ')}`);
}

console.log(`\n【2】选到了非 slimefun 命名空间（可能抓错附属贴图）：${report.crossNamespace.length} 个`);
for (const entry of report.crossNamespace.slice(0, 25)) {
  console.log(`  ${entry.id}\n      选了: ${entry.chosen}${entry.slimefunAlternative ? `\n      包里有 slimefun 版: ${entry.slimefunAlternative}` : '\n      （slimefun 命名空间里没有同名文件）'}`);
}

console.log(`\n【3】不是精确文件名匹配（走路径/别名）：${report.fuzzy.length} 个`);
for (const entry of report.fuzzy.slice(0, 25)) console.log(`  ${entry.id} ← ${entry.viaPath}`);

console.log(`\n【4】没有图标：${report.missing.length} 个`);
console.log('  ' + report.missing.slice(0, 40).join(', '));
