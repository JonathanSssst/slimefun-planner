#!/usr/bin/env node
/**
 * 用资源包的**模型文件树**核对"物品 ID → 贴图"的对应关系。
 *
 * 原理：资源包把每个自定义物品的模型放在
 *   assets/<ns>/models/<路径>.json
 * 而模型内部被作者用零宽字符 + \uXXXX 转义混淆过，直接读 keys 会读不到。
 * 所以我们不解析 JSON 的键，而是把整个 json 文本里出现的贴图引用（含转义形式）全部抓出来，
 * 再看它指向的贴图文件是否存在。
 *
 * 身份判定：模型路径的**最后一段**要等于物品 ID 的小写形式；
 * 贴图优先取"与模型同路径的贴图"（作者惯例：模型与贴图目录一一对应）。
 *
 * 用法：
 *   node tools/verify-icon-models.mjs                 # 核对现状
 *   node tools/verify-icon-models.mjs --json          # 输出 JSON 结果
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const packPath = process.argv.slice(2).find((value) => !value.startsWith('--'))
  || 'E:/Minecraft/.minecraft/versions/DT-1.21.11-Fabric/resourcepacks/1.21.11粘液科技材质包.zip';
const asJson = process.argv.includes('--json');

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

/** 把 json 文本里的 \uXXXX 还原，并去掉零宽字符 */
function cleanText(text) {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
}

const zip = readZip(await readFile(packPath));
const textureEntries = new Map(
  zip.entries
    .filter((e) => e.name.endsWith('.png'))
    .map((e) => [e.name.replace(/^assets\//, '').replace(/\.png$/, ''), e]),
);
const textureNames = new Set(textureEntries.keys());

const modelEntries = zip.entries.filter((e) => /^assets\/[^/]+\/models\/.*\.json$/.test(e.name));
const items = (await readFile(join(root, 'data', 'recipes.core.jsonl'), 'utf8'))
  .split(/\r?\n/).filter(Boolean).slice(1).map((line) => JSON.parse(line));
const cache = existsSync(join(root, 'data', 'icons', 'icon-cache.json'))
  ? JSON.parse(await readFile(join(root, 'data', 'icons', 'icon-cache.json'), 'utf8'))
  : {};

const report = { matched: [], mismatch: [], noModel: [], vanillaTexture: [] };

for (const item of items) {
  const short = item.id.split(':').pop().toLowerCase();
  // 找"最后一段等于物品 id"的模型
  const candidates = modelEntries.filter((entry) => {
    const path = entry.name.replace(/^assets\/[^/]+\/models\//, '').replace(/\.json$/, '');
    return path.split('/').pop() === short;
  });
  if (candidates.length === 0) {
    report.noModel.push(item.id);
    continue;
  }

  // 优先 slimefun 命名空间的模型
  candidates.sort((a, b) => {
    const aSf = a.name.startsWith('assets/slimefun/') ? 0 : 1;
    const bSf = b.name.startsWith('assets/slimefun/') ? 0 : 1;
    return aSf - bSf;
  });
  const model = candidates[0];
  const modelPath = model.name.replace(/^assets\/[^/]+\/models\//, '').replace(/\.json$/, '');

  const text = cleanText(zip.read(model).toString('utf8'));
  const refs = [...new Set([...text.matchAll(/"([a-z0-9_]+:[a-z0-9_/.\-]+)"/gi)].map((m) => m[1]))];
  const ourTextureRefs = refs.filter((ref) => !ref.startsWith('minecraft:') && !ref.startsWith('item/'));

  // 作者惯例：模型路径与贴图路径一一对应
  const samePath = textureNames.has(modelPath) ? modelPath : null;
  const sameName = [...textureNames].find((name) => name.endsWith(`/${short}`)) || null;
  const best = samePath || ourTextureRefs.find((ref) => textureNames.has(ref.split(':').slice(1).join(':')))
    || sameName;

  const entry = {
    id: item.id,
    model: model.name.replace(/^assets\//, ''),
    candidates: candidates.length,
    samePath,
    refs,
    resolved: best ? `assets/${best}.png` : null,
    cached: cache[item.id] || null,
    sameBytes: null,
  };

  // 真正的判据：我们抽出来的 PNG 与模型推导出的贴图**内容是否一致**
  if (best && cache[item.id] && existsSync(join(root, cache[item.id]))) {
    const textureEntry = textureEntries.get(best);
    if (textureEntry) {
      const expected = zip.read(textureEntry);
      const actual = await readFile(join(root, cache[item.id]));
      entry.sameBytes = expected.equals(actual);
    }
  }

  if (!best) {
    report.vanillaTexture.push({ ...entry, note: '模型只引用原版贴图，没有自定义贴图' });
  } else if (entry.sameBytes === false) {
    report.mismatch.push(entry);
  } else {
    report.matched.push(entry);
  }
}

if (asJson) {
  const out = join(root, 'research', 'icon-model-check.json');
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`已写出 ${out}`);
}

console.log(`物品 ${items.length} 个；有匹配模型 ${items.length - report.noModel.length} 个`);
console.log(`  贴图一致      ：${report.matched.length}`);
console.log(`  贴图不一致    ：${report.mismatch.length}`);
console.log(`  模型只用原版贴图：${report.vanillaTexture.length}`);
console.log(`  没有模型文件  ：${report.noModel.length}`);

console.log('\n【不一致】');
for (const entry of report.mismatch.slice(0, 20)) {
  console.log(`  ${entry.id}\n      模型: ${entry.model}\n      应为: ${entry.resolved}\n      实际: ${entry.cached}`);
}
console.log('\n【模型只用原版贴图（很可能我们抓错了）】');
for (const entry of report.vanillaTexture.slice(0, 25)) {
  console.log(`  ${entry.id}\n      模型: ${entry.model}\n      引用: ${entry.refs.join(', ') || '(无)'}\n      我们抓的: ${entry.cached}`);
}
console.log(`\n【没有模型文件（多为玩家头颅/盔甲图层）】共 ${report.noModel.length} 个`);
console.log('  ' + report.noModel.slice(0, 30).join(', '));
