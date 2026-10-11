#!/usr/bin/env node
/**
 * 从本机资源包抽取物品图标（权威版）。
 *
 * 与旧版 extract-local-icons.mjs 的区别：**以资源包的模型文件为主要依据**。
 * 资源包里每个自定义物品都有一个模型文件：
 *     assets/<命名空间>/models/<路径>.json
 * 例：assets/slimefun/models/slimefun/resources/dusts/iron_dust.json
 * 它的路径（去掉 models/ 前缀）就是贴图路径：
 *     assets/slimefun/textures/slimefun/resources/dusts/iron_dust.png
 * 这是作者自己的对应关系，比"按文件名猜"可靠得多。
 * （模型 json 内部被作者混淆过——键名带零宽字符、内容用 \uXXXX 转义——所以只取路径，不解析内部键。）
 *
 * 只有在找不到模型文件时，才回退到"文件名 → 相对路径 → 别名规则 → 别名表"。
 *
 * 抽出的 PNG 只写进 data/icons/（已在 .gitignore 里排除，不会提交到公开仓库）。
 *
 * 用法：
 *   node tools/extract-pack-icons.mjs [资源包.zip] [--dry]
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const iconDir = join(root, 'data', 'icons');
const dryRun = process.argv.includes('--dry');

function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip');
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

/** 物品 ID → 在资源包里"可能对应的文件名"（去掉命名空间、小写） */
function baseNames(short) {
  const names = new Set([short]);
  const talisman = short.match(/^(?:ender_)?(.+)_talisman$/);
  if (talisman) {
    names.add(talisman[1]);
    const spelling = { magician: 'magican', lava: 'lava_walker', fire: 'firefighter', water: 'water_breather' }[talisman[1]];
    if (spelling) names.add(spelling);
  }
  const android = short.match(/^programmable_android(_2|_3)?(?:_(.+))?$/);
  if (android) {
    names.add(`programmable_android${android[1] || ''}_${android[2] || 'normal'}`);
    if (android[2]) names.add(android[2]);
    names.add('normal');
  }
  const numbered = short.match(/^(.+)_(\d+)$/);
  if (numbered) names.add(`${numbered[1]}${numbered[2]}`);
  return [...names];
}

async function main() {
  const argPath = process.argv.slice(2).find((value) => !value.startsWith('--'));
  const packPath = argPath
    || (await (async () => {
      const dirs = [
        'E:/Minecraft/.minecraft/versions/DT-1.21.11-Fabric/resourcepacks',
        'E:/Minecraft/.minecraft/resourcepacks',
      ];
      for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        const hit = (await readdir(dir)).find((name) => /粘液|slimefun/i.test(name) && /\.zip$/i.test(name));
        if (hit) return join(dir, hit);
      }
      throw new Error('没找到粘液科技资源包，请把 zip 路径作为参数传入');
    })());
  if (!existsSync(packPath)) throw new Error(`资源包不存在：${packPath}`);
  console.log(`资源包：${packPath}`);

  const zip = readZip(await readFile(packPath));

  // 索引：贴图、模型
  const textures = new Map();   // "slimefun/resources/dusts/iron_dust" → entry
  const models = new Map();     // 模型末段名 → [路径…]
  for (const entry of zip.entries) {
    const texMatch = entry.name.match(/^assets\/([^/]+)\/textures\/(.+)\.png$/);
    if (texMatch) {
      const key = `${texMatch[1]}/${texMatch[2]}`;
      if (!textures.has(key)) textures.set(key, entry);
    }
    const modelMatch = entry.name.match(/^assets\/([^/]+)\/models\/(.+)\.json$/);
    if (modelMatch) {
      const path = `${modelMatch[1]}/${modelMatch[2]}`;
      const tail = modelMatch[2].split('/').pop();
      if (!models.has(tail)) models.set(tail, []);
      models.get(tail).push(path);
    }
  }

  // 别名表（人工补充的特例）
  let extraAliases = {};
  try {
    const aliasFile = JSON.parse(await readFile(join(root, 'data', 'icon-aliases.json'), 'utf8'));
    extraAliases = aliasFile.extra && typeof aliasFile.extra === 'object' ? aliasFile.extra : {};
  } catch { /* 可选 */ }

  const items = (await readFile(join(root, 'data', 'recipes.core.jsonl'), 'utf8'))
    .split(/\r?\n/).filter(Boolean).slice(1).map((line) => JSON.parse(line));

  const map = {};
  const stats = { model: 0, textureByName: 0, textureByPath: 0, alias: 0, skipped: [] };
  // 保留已有来源记录（例如先跑过 fetch-head-icons.mjs 生成的头颅图标）
  const provenancePath = join(iconDir, 'icon-provenance.json');
  let provenance = {};
  try {
    provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  } catch { provenance = {}; }

  for (const item of items) {
    const short = item.id.split(':').pop().toLowerCase();
    const isMinecraft = item.id.startsWith('minecraft:') || !item.id.includes(':');
    if (isMinecraft) continue; // 原版物品走在线镜像

    let textureEntry = null;
    let via = null;

    // 1) 模型文件：优先 slimefun 命名空间，模型路径 = 贴图路径
    for (const base of baseNames(short)) {
      const modelPaths = (models.get(base) || [])
        .slice()
        .sort((a, b) => (a.startsWith('slimefun/') ? -1 : 0) - (b.startsWith('slimefun/') ? -1 : 0));
      const hit = modelPaths.find((path) => textures.has(path));
      if (hit) {
        textureEntry = textures.get(hit);
        via = `model:${hit}`;
        break;
      }
    }

    // 2) 直接按文件名找贴图（同命名空间优先）
    if (!textureEntry) {
      for (const base of baseNames(short)) {
        for (const namespace of ['slimefun', 'minecraft']) {
          for (const [key, entry] of textures) {
            if (key.endsWith(`/${base}`) && key.startsWith(`${namespace}/`)) { textureEntry = entry; via = `texture:${key}`; break; }
          }
          if (textureEntry) break;
        }
        if (textureEntry) break;
      }
    }

    // 3) 人工别名表
    if (!textureEntry) {
      const extra = extraAliases[short];
      const list = Array.isArray(extra) ? extra : (extra ? [extra] : []);
      for (const candidate of list) {
        const key = [...textures.keys()].find((k) => k.toLowerCase() === `slimefun/${candidate}`.toLowerCase() || k.toLowerCase() === candidate.toLowerCase());
        if (key) { textureEntry = textures.get(key); via = `alias:${key}`; break; }
      }
    }

    if (!textureEntry) {
      // 资源包没有这张贴图：保留已有的头颅图标（如果之前生成过），否则记为缺图
      if (provenance[item.id]?.startsWith('head:')) {
        map[item.id] = `data/icons/${item.id.replace(/[^A-Za-z0-9_.-]/g, '_')}.png`;
        continue;
      }
      stats.skipped.push(item.id);
      continue;
    }

    if (via.startsWith('model:')) stats.model += 1;
    else if (via.startsWith('texture:')) stats.textureByName += 1;
    else stats.alias += 1;

    const file = `${item.id.replace(/[^A-Za-z0-9_.-]/g, '_')}.png`;
    if (!dryRun) {
      await writeFile(join(iconDir, file), zip.read(textureEntry));
      map[item.id] = `data/icons/${file}`;
      provenance[item.id] = via;
    }
  }

  if (!dryRun) {
    await mkdir(iconDir, { recursive: true });
    await writeFile(join(iconDir, 'icon-cache.json'), `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    await writeFile(join(iconDir, 'icon-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  }

  const total = items.filter((item) => item.id.includes(':') && !item.id.startsWith('minecraft:')).length;
  console.log(`粘液物品 ${total} 个：`);
  console.log(`  由模型文件确定：${stats.model}`);
  console.log(`  按文件名定位  ：${stats.textureByName}`);
  console.log(`  人工别名表    ：${stats.alias}`);
  console.log(`  没找到贴图    ：${stats.skipped.length}`);
  if (stats.skipped.length > 0) console.log(`    ${stats.skipped.join(', ')}`);
  if (dryRun) console.log('（--dry 只统计，没有写文件）');
  else console.log(`已写入 ${Object.keys(map).length} 张到 data/icons/，并记录来源到 icon-provenance.json`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
