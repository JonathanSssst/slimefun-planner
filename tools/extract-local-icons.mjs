#!/usr/bin/env node
/**
 * 从**本机已安装的资源包**里抽取物品图标，生成离线图标缓存。
 *
 * 为什么要从本地资源包抽：粘液科技插件本体不带贴图（贴图在服务端资源包里，
 * 客户端通过资源包 / CustomModelData 呈现）。公开仓库里的贴图不全（未完成状态），
 * 而玩家本机的资源包是最全、且和游戏内所见完全一致的。
 *
 * 抽出来的 PNG 只写进 data/icons/（已在 .gitignore 里排除，不会提交到公开仓库）。
 *
 * 用法：
 *   node tools/extract-local-icons.mjs [资源包.zip 路径] [--dry]
 * 不传路径时，会自动在常见的 .minecraft 目录里找名字含「粘液 / slimefun」的资源包。
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const iconDir = join(root, 'data', 'icons');
const dryRun = process.argv.includes('--dry');

const SEARCH_DIRS = [
  'E:/Minecraft/.minecraft/versions',
  'E:/Minecraft/.minecraft/resourcepacks',
  'E:/Minecraft/.minecraft',
];

/** 极简 zip 读取器：只做中央目录解析 + 解压需要的条目 */
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到 End of Central Directory）');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const localOff = buffer.readUInt32LE(p + 42);
    entries.push({ name: buffer.toString('utf8', p + 46, p + 46 + nameLen), method, compSize, localOff });
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

async function findLocalPacks() {
  const found = [];
  for (const dir of SEARCH_DIRS) {
    if (!existsSync(dir)) continue;
    const walk = async (current, depth) => {
      if (depth > 3) return;
      let list;
      try {
        list = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of list) {
        const full = join(current, item.name);
        if (item.isDirectory()) await walk(full, depth + 1);
        else if (/\.zip$/i.test(item.name) && /粘液|slimefun|sf材质|科技/i.test(item.name)) found.push(full);
      }
    };
    await walk(dir, 0);
  }
  return found;
}

/** 生成别名候选路径（相对 assets/<ns>/textures/ 之后，不含 .png） */
function aliasCandidates(short) {
  const out = [];

  // 护身符：XX_TALISMAN → talisman1/xx；ENDER_XX_TALISMAN → talisman2/xx
  const talisman = short.match(/^(.+)_talisman$/);
  if (talisman) {
    const isEnder = short.startsWith('ender_');
    const base = talisman[1].replace(/^ender_/, '');
    const dir = isEnder ? 'talisman2' : 'talisman1';
    const spelling = { magician: 'magican', lava: 'lava_walker', fire: 'firefighter', water: 'water_breather' }[base] || base;
    out.push(`slimefun/${dir}/${spelling}`, `slimefun/${dir}/${base}`);
  }

  // 安卓机器人：PROGRAMMABLE_ANDROID[_2|_3][_工种]
  const android = short.match(/^programmable_android(_2|_3)?(?:_(.+))?$/);
  if (android) {
    const version = android[1] ? android[1].slice(1) : '';
    const job = android[2] || 'normal';
    const dir = `slimefun/androids/android${version}`;
    out.push(`${dir}/${job}`, `${dir}/programmable_android_${job}`, `${dir}/normal`);
  }

  // 编号后缀：electric_gold_pan_2 → electric_gold_pan2
  const numbered = short.match(/^(.+)_(\d+)$/);
  if (numbered) out.push(`${numbered[1]}${numbered[2]}`);

  // 去掉常见后缀
  out.push(short.replace(/^ender_/, ''), short.replace(/_ingot$|_dust$|_plate$/, ''));

  return [...new Set(out)];
}

async function main() {
  const argPath = process.argv.slice(2).find((a) => !a.startsWith('--'));
  let packPath = argPath;
  if (!packPath) {
    const candidates = await findLocalPacks();
    if (candidates.length === 0) throw new Error('没找到含「粘液/slimefun」字样的资源包，请手动把 zip 路径作为参数传入');
    candidates.sort((a, b) => b.length - a.length);
    packPath = candidates[0];
    console.log(`自动选择资源包：${packPath}`);
    if (candidates.length > 1) console.log(`（另有 ${candidates.length - 1} 个候选：${candidates.slice(1).map((c) => c.split(/[/\\]/).pop()).join('、')}）`);
  }
  if (!existsSync(packPath)) throw new Error(`资源包不存在：${packPath}`);

  // 别名表的 extra 段：物品 ID（去命名空间小写）→ 相对路径
  let extraAliases = {};
  try {
    const aliasFile = JSON.parse(await readFile(join(root, 'data', 'icon-aliases.json'), 'utf8'));
    extraAliases = aliasFile.extra && typeof aliasFile.extra === 'object' ? aliasFile.extra : {};
  } catch {
    extraAliases = {};
  }

  const zip = readZip(await readFile(packPath));
  const pngs = zip.entries.filter((e) => e.name.endsWith('.png'));
  // 匹配顺序：
  //   1) 文件名（不含目录）：大多数物品贴图按物品 ID 命名
  //   2) 相对路径（去掉 assets/<命名空间>/textures/）：补 talisman1/miner 这类按目录分组的
  //   3) 别名规则 + data/icon-aliases.json 里的特例
  const byBase = new Map();
  const byPath = new Map();
  for (const entry of pngs) {
    const base = entry.name.split('/').pop().toLowerCase().replace(/\.png$/i, '');
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(entry);
    const match = entry.name.match(/^assets\/[^/]+\/textures\/(.+)$/);
    if (match) {
      const key = match[1].toLowerCase().replace(/\.png$/i, '');
      if (!byPath.has(key)) byPath.set(key, entry);
    }
  }

  const findTexture = (short) => {
    const direct = byBase.get(short)?.[0];
    if (direct) return direct;
    // 路径里以 /<id> 结尾，或最后一段正好等于 id
    for (const [key, entry] of byPath) {
      if (key === short || key.endsWith(`/${short}`) || key.split('/').pop() === short) return entry;
    }
    // 别名规则（护身符、安卓机器人、编号后缀等）+ icon-aliases.json 里的特例
    const extra = extraAliases[short];
    const extraList = Array.isArray(extra) ? extra : (extra ? [extra] : []);
    for (const candidate of [...extraList, ...aliasCandidates(short)]) {
      const entry = byPath.get(candidate.toLowerCase());
      if (entry) return entry;
    }
    return null;
  };

  const items = (await readFile(join(root, 'data', 'recipes.core.jsonl'), 'utf8'))
    .split(/\r?\n/).filter(Boolean).slice(1).map((line) => JSON.parse(line));

  const map = {};
  const matched = [];
  const missed = [];
  for (const item of items) {
    const short = item.id.split(':').pop().toLowerCase();
    const entry = findTexture(short);
    if (!entry) {
      missed.push(item.id);
      continue;
    }
    matched.push(item.id);
    if (dryRun) continue;
    const file = `${item.id.replace(/[^A-Za-z0-9_.-]/g, '_')}.png`;
    await writeFile(join(iconDir, file), zip.read(entry));
    map[item.id] = `data/icons/${file}`;
  }

  if (!dryRun) {
    await mkdir(iconDir, { recursive: true });
    await writeFile(join(iconDir, 'icon-cache.json'), `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  }

  console.log(`资源包内 PNG：${pngs.length} 张（不重名 ${byBase.size} 个文件名）`);
  console.log(`与数据集匹配：${matched.length} / ${items.length}（${(matched.length / items.length * 100).toFixed(1)}%）`);
  if (missed.length > 0) console.log(`未匹配 ${missed.length} 个（会走原版镜像 / 徽章兜底）：${missed.slice(0, 10).join(', ')}…`);
  if (dryRun) console.log('（--dry 只统计，没有写文件）');
  else console.log(`已写入 ${Object.keys(map).length} 张到 data/icons/ 并更新 icon-cache.json`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
