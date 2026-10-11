#!/usr/bin/env node
/**
 * 用资源包里的**模型定义**验证"物品 ID → 贴图"的对应关系。
 *
 * 资源包渲染物品不是靠文件名猜的：物品模型（assets/<ns>/models/**）里写着它引用哪张贴图，
 * OptiFine CIT（assets/minecraft/optifine/cit/**）里也写着每个自定义物品用哪个模型。
 * 这个脚本把这些引用关系抽出来，和我们的匹配结果对照，找出"名字对得上但贴图不同"的情况。
 *
 * 用法：node tools/verify-icon-sources.mjs [资源包.zip]
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const packPath = process.argv[2]
  || 'E:/Minecraft/.minecraft/versions/DT-1.21.11-Fabric/resourcepacks/1.21.11粘液科技材质包.zip';

function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    entries.push({
      name: buffer.toString('utf8', p + 46, p + 46 + nameLen),
      method: buffer.readUInt16LE(p + 10),
      compSize: buffer.readUInt32LE(p + 20),
      localOff: buffer.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    entries,
    read(entry) {
      const nameLen = buffer.readUInt16LE(entry.localOff + 26);
      const extraLen = buffer.readUInt16LE(entry.localOff + 28);
      const start = entry.localOff + 30 + nameLen + extraLen;
      const raw = buffer.subarray(start, start + entry.compSize);
      return entry.method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    },
  };
}

const zip = readZip(await readFile(packPath));
const byName = new Map(zip.entries.map((entry) => [entry.name, entry]));

console.log(`资源包：${packPath.split(/[/\\]/).pop()}`);
console.log(`条目数：${zip.entries.length}\n`);

// ---------- 1. 物品模型里引用了哪些贴图 ----------
const modelFiles = zip.entries.filter((e) => /^assets\/[^/]+\/models\/.*\.json$/.test(e.name));
console.log(`【1】物品模型（models/**.json）：${modelFiles.length} 个`);

const modelTextures = [];
for (const entry of modelFiles) {
  let json;
  try {
    json = JSON.parse(zip.read(entry).toString('utf8'));
  } catch {
    continue;
  }
  const layer0 = json?.textures?.layer0 || json?.textures?.layer1 || json?.textures?.['0'];
  if (layer0) modelTextures.push({ model: entry.name, texture: layer0 });
}
console.log(`    能解析出贴图引用的：${modelTextures.length} 个`);
for (const sample of modelTextures.slice(0, 8)) {
  console.log(`      ${sample.model.replace(/^assets\//, '')} → ${sample.texture}`);
}

// ---------- 2. OptiFine CIT 里自定义物品用哪个模型 ----------
const citFiles = zip.entries.filter((e) => /^assets\/minecraft\/optifine\/cit\/.*\.(properties|json)$/.test(e.name));
console.log(`\n【2】OptiFine CIT 配置：${citFiles.length} 个`);
const citItems = [];
for (const entry of citFiles) {
  const text = zip.read(entry).toString('utf8');
  const key = text.match(/^items\s*=\s*(.+)$/m)?.[1]?.trim();
  const model = text.match(/^model\s*=\s*(.+)$/m)?.[1]?.trim();
  const texture = text.match(/^texture\s*=\s*(.+)$/m)?.[1]?.trim();
  const cmd = text.match(/^custom_model_data\s*=\s*(.+)$/m)?.[1]?.trim();
  if (key || model || texture) citItems.push({ file: entry.name, item: key, model, texture, customModelData: cmd });
}
console.log(`    能解析出条目的：${citItems.length} 个`);
for (const sample of citItems.slice(0, 8)) {
  console.log(`      ${sample.file.replace(/^assets\/minecraft\/optifine\/cit\//, '')}\n        items=${sample.item || '-'} model=${sample.model || '-'} texture=${sample.texture || '-'} cmd=${sample.customModelData || '-'}`);
}

// ---------- 3. Slimefun 命名空间下贴图的实际目录分布（看命名规律） ----------
const sfTextures = zip.entries
  .filter((e) => e.name.startsWith('assets/slimefun/textures/') && e.name.endsWith('.png'))
  .map((e) => e.name.replace('assets/slimefun/textures/', ''));
const dirs = {};
for (const name of sfTextures) {
  const dir = name.split('/').slice(0, -1).join('/');
  dirs[dir] = (dirs[dir] || 0) + 1;
}
console.log(`\n【3】slimefun 贴图目录（共 ${sfTextures.length} 张）：`);
for (const [dir, count] of Object.entries(dirs).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`      ${dir.padEnd(40)} ${count}`);
}

// ---------- 4. 我们的匹配 vs 包里的模型引用 ----------
const items = (await readFile(join(root, 'data', 'recipes.core.jsonl'), 'utf8'))
  .split(/\r?\n/).filter(Boolean).slice(1).map((line) => JSON.parse(line));
const cache = existsSync(join(root, 'data', 'icons', 'icon-cache.json'))
  ? JSON.parse(await readFile(join(root, 'data', 'icons', 'icon-cache.json'), 'utf8'))
  : {};

console.log('\n【4】抽查：我们抽的贴图 vs 资源包模型引用的贴图');
const checks = ['IRON_DUST', 'COPPER_DUST', 'CARBON', 'COMPRESSED_CARBON', 'STEEL_INGOT', 'SYNTHETIC_DIAMOND', 'REINFORCED_ALLOY_INGOT'];
for (const short of checks) {
  const id = `simefun4:${short}`;
  const item = items.find((entry) => entry.id === id);
  const chosen = cache[id];
  // 找该物品的模型（models/ 下同名 json）
  const modelEntry = zip.entries.find((e) => e.name === `assets/slimefun/models/${short.toLowerCase()}.json`)
    || zip.entries.find((e) => e.name === `assets/slimefun/models/item/${short.toLowerCase()}.json`);
  let modelTexture = null;
  if (modelEntry) {
    try {
      const json = JSON.parse(zip.read(modelEntry).toString('utf8'));
      modelTexture = json?.textures?.layer0 || json?.textures?.['0'] || null;
    } catch { /* ignore */ }
  }
  console.log(`  ${id}（${item?.name || '?'}）`);
  console.log(`      我们抽的：${chosen || '（无）'}`);
  console.log(`      模型引用：${modelEntry ? modelEntry.name : '（包内无同名模型 json）'} ${modelTexture ? `→ ${modelTexture}` : ''}`);
}
