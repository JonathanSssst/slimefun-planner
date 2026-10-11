#!/usr/bin/env node
/**
 * 把插件源码导出的分类表整理成精简版 data/category-sources.json 并入库。
 * 原始导出（带每条证据行号）在 research/item-category-map.json，属临时产物不入库。
 *
 * 用法：node tools/pack-category-sources.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

/** 指南书真实分组的中文名（与 tools/build-categories.mjs 保持一致） */
const GROUP_NAMES = {
  weapons: '武器',
  items: '有用的物品',
  basic_machines: '基础机器',
  tools: '工具',
  resources: '矿物资源',
  food: '食物',
  magical_items: '魔法物品',
  magical_armor: '魔法防具',
  tech_misc: '科技零件',
  misc: '杂项用品',
  armor: '防具',
  talismans: '护身符 (I 级)',
  ender_talismans: '末影护身符 (II 级)',
  magical_gadgets: '魔法道具',
  technical_gadgets: '科技工具',
  electricity: '能源与电力',
  gps: '基于 GPS 的机器',
  androids: '可编程式机器人',
  cargo: '货物管理',
  christmas: '圣诞节 (12 月)',
  valentines_day: '情人节 (2 月 14 日)',
  easter: '复活节 (4 月)',
  halloween: '万圣节 (10 月 31 日)',
  birthday: 'TheBusyBiscuit 的生日 (10 月 26 日)',
};

async function main() {
  const rawPath = join(root, 'research', 'item-category-map.json');
  if (!existsSync(rawPath)) {
    throw new Error('找不到 research/item-category-map.json，请先用导出的原始文件（见 README 的"分类数据"一节）');
  }
  const raw = JSON.parse(await readFile(rawPath, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.items || []);

  const categories = {};
  const items = [];
  const seen = new Set();
  for (const entry of list) {
    const id = entry.item || entry.id;
    const category = entry.category || entry.group;
    if (!id || !category || seen.has(id)) continue;
    seen.add(id);
    items.push([id, category]);
    categories[category] = (categories[category] || 0) + 1;
  }

  const output = {
    _说明: '粘液科技指南书分类的权威映射，由 Slimefun4 源码导出：解析 implementation/setup/SlimefunItemSetup.java 里每个 register(...) 调用，'
      + '分类键取自 DefaultItemGroups.java（即游戏内指南书的真实分组）。来源仓库：github.com/Slimefun/Slimefun4（experimental 分支）。',
    _分类中文名: GROUP_NAMES,
    统计: { 物品数: items.length, 分类数: Object.keys(categories).length },
    分类计数: categories,
    /** [物品ID, 分类键] */
    物品分类表: items,
  };

  await writeFile(join(root, 'data', 'category-sources.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`已写出 data/category-sources.json：${items.length} 个物品，${Object.keys(categories).length} 个分类`);
  console.log('分类计数：', Object.entries(categories).map(([k, v]) => `${k}:${v}`).join(' '));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
