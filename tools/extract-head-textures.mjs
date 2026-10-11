#!/usr/bin/env node
/**
 * 抽取 Slimefun 的 HeadTexture 枚举（物品皮肤哈希），与数据集比对覆盖率。
 *
 * 背景：Slimefun 插件 jar 里不带贴图；自定义物品的"贴图"是玩家头颅皮肤，
 * 哈希值写在 HeadTexture.java 里。这个脚本把哈希抓出来，算出能覆盖多少物品，
 * 并输出 research/head-textures.json 供图标方案使用。
 *
 * 用法：node --use-system-ca tools/extract-head-textures.mjs
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const SOURCE = 'https://raw.githubusercontent.com/Slimefun/Slimefun4/experimental/src/main/java/io/github/thebusybiscuit/slimefun4/utils/HeadTexture.java';

async function main() {
  const response = await fetch(SOURCE, { headers: { 'User-Agent': 'slimefun-planner-headtextures' } });
  if (!response.ok) throw new Error(`拉取 HeadTexture.java 失败：HTTP ${response.status}`);
  const text = await response.text();

  await mkdir(join(root, 'research'), { recursive: true });
  await writeFile(join(root, 'research', 'HeadTexture.java'), text, 'utf8');

  const map = {};
  const re = /([A-Z0-9_]+)\("([0-9a-f]{20,})"\)/g;
  let match;
  while ((match = re.exec(text)) !== null) map[match[1]] = match[2];
  console.log(`HeadTexture 条目数：${Object.keys(map).length}`);

  const lines = (await readFile(join(root, 'data', 'recipes.core.jsonl'), 'utf8'))
    .split(/\r?\n/).filter(Boolean).slice(1);
  const items = lines.map((line) => JSON.parse(line));
  const packMap = JSON.parse(await readFile(join(root, 'data', 'icon-map.json'), 'utf8'));

  const headHit = items.filter((item) => map[item.id.split(':').pop()]).map((item) => item.id);
  const both = headHit.filter((id) => packMap[id]);
  const union = new Set([...headHit, ...Object.keys(packMap)]);

  console.log(`有头颅贴图的物品：${headHit.length}`);
  console.log(`资源包映射物品  ：${Object.keys(packMap).length}`);
  console.log(`两者都有        ：${both.length}`);
  console.log(`合并可覆盖      ：${union.size} / ${items.length}（${(union.size / items.length * 100).toFixed(1)}%）`);

  await writeFile(join(root, 'research', 'head-textures.json'), `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  console.log(`已写出 research/head-textures.json`);
  console.log(`示例：${headHit.slice(0, 8).join(', ')}`);
}

main().catch((err) => {
  console.error(err.message);
  console.error('提示：证书报错时请加 --use-system-ca。');
  process.exit(1);
});
