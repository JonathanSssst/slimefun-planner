#!/usr/bin/env node
/**
 * 分析本机资源包里"没按物品 ID 直接命名"的贴图，给出可用的别名候选。
 * 用于人工/自动补全 data/icons/icon-aliases.json。
 *
 * 用法：node tools/suggest-icon-aliases.mjs [资源包.zip]
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const packPath = process.argv[2] || 'E:/Minecraft/.minecraft/versions/DT-1.21.11-Fabric/resourcepacks/1.21.11粘液科技材质包.zip';

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
for (const name of pngs) {
  const base = name.split('/').pop().toLowerCase().replace(/\.png$/, '');
  byBase.set(base, name);
}

const items = (await readFile(join(root, 'data', 'recipes.core.jsonl'), 'utf8'))
  .split(/\r?\n/).filter(Boolean).slice(1).map((line) => JSON.parse(line));

const missed = items.filter((item) => !byBase.has(item.id.split(':').pop().toLowerCase()));
console.log(`未直接匹配的物品：${missed.length} 个\n`);

/** 别名猜测规则：物品 ID → 资源包文件名（去掉命名空间、转小写） */
function candidates(id) {
  const short = id.split(':').pop().toLowerCase();
  const out = [];
  const push = (value) => { if (value && byBase.has(value)) out.push(value); };

  // 护身符：XX_TALISMAN / ENDER_XX_TALISMAN → talisman1|2/xx.png
  let m = short.match(/^(.+)_talisman$/);
  if (m) {
    const base = m[1].replace(/^ender_/, '');
    const dir = short.startsWith('ender_') ? 'talisman2' : 'talisman1';
    push(`${dir}/${base}`);
    push(`${dir}/${base.replace(/^common$/, 'common')}`);
    if (base === 'magician') push(`${dir}/magican`);
    if (base === 'angel') push(`${dir}/angel`);
  }
  // 去除常见后缀再试
  push(short.replace(/^ender_/, ''));
  push(short.replace(/_ingot$|_dust$|_plate$|_wire$/, ''));
  // 子目录内同名文件（例如 magical_armor/slime_armor_steel/xxx）
  for (const [base, full] of byBase) {
    if (base !== short && full.includes(`/${short}.png`)) out.push(base);
  }
  return [...new Set(out)];
}

const suggestions = {};
let solved = 0;
for (const item of missed) {
  const found = candidates(item.id);
  if (found.length > 0) solved += 1;
  suggestions[item.id] = found;
}

console.log(`规则能补上 ${solved} / ${missed.length} 个\n`);
for (const [id, options] of Object.entries(suggestions)) {
  if (options.length === 0) continue;
  const full = byBase.get(options[0]);
  console.log(`  ${id}\n      → ${options.join(' / ')}\n      路径: ${full}`);
}
console.log('\n仍然没有候选的：');
console.log(Object.entries(suggestions).filter(([, v]) => v.length === 0).map(([k]) => k).join(', '));
