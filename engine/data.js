/**
 * 配方数据集加载（环境无关部分在 dataset.js，这里负责读 JSONL 文本并应用用户补录）。
 */

import { createDataset } from './dataset.js';

/**
 * 默认「采集终点」名单（可在界面里勾选/增删）。
 *
 * 判定逻辑：名单里的物品不再展开配方，直接进采集清单。
 * 目标物品即使命中名单也会照常展开——否则你输入"铁粉×64"只会得到"去弄 64 个铁粉"，
 * 而看不到它其实可以用矿石粉碎机或洗矿机做出来。
 */
export const BASE_MATERIAL_GROUPS = [
  {
    key: 'vanilla-ore',
    label: '原版矿物与锭',
    items: [
      'COAL', 'CHARCOAL', 'IRON_INGOT', 'GOLD_INGOT', 'COPPER_INGOT',
      'DIAMOND', 'EMERALD', 'REDSTONE', 'LAPIS_LAZULI', 'QUARTZ',
      'GLOWSTONE_DUST', 'NETHERITE_INGOT', 'RAW_IRON', 'RAW_GOLD', 'RAW_COPPER',
      'IRON_ORE', 'GOLD_ORE', 'COPPER_ORE', 'DIAMOND_ORE', 'EMERALD_ORE',
      'REDSTONE_ORE', 'LAPIS_ORE', 'COAL_ORE', 'QUARTZ_ORE',
    ],
  },
  {
    key: 'vanilla-gather',
    label: '原版采集物（打怪/挖矿/种地）',
    items: [
      'BLAZE_ROD', 'ENDER_PEARL', 'SLIME_BALL', 'STRING', 'LEATHER', 'FEATHER',
      'BONE', 'GUNPOWDER', 'SUGAR_CANE', 'OAK_LOG', 'SAND', 'GLASS',
      'CLAY_BALL', 'FLINT', 'NETHERRACK', 'OBSIDIAN', 'WITHER_SKELETON_SKULL',
      'NETHER_STAR', 'NAUTILUS_SHELL', 'PHANTOM_MEMBRANE', 'GHAST_TEAR',
      'MAGMA_CREAM', 'SPIDER_EYE', 'ROTTEN_FLESH', 'EGG', 'WHEAT', 'CARROT',
      'POTATO', 'BEETROOT', 'COCOA_BEANS', 'HONEYCOMB', 'HONEY_BLOCK',
    ],
  },
  {
    key: 'slimefun-raw',
    label: '粘液科技可在机器里加工的原料',
    items: [
      'simefun4:BUCKET_OF_OIL', 'simefun4:SULFATE', 'simefun4:BORAX',
      'simefun4:NETHER_ICE', 'simefun4:SALT', 'simefun4:MAGNESIUM_SALT',
      'simefun4:SIFTED_ORE', 'simefun4:STONE_CHUNK', 'simefun4:URANIUM',
    ],
  },
];

/** 默认名单（扁平） */
export const DEFAULT_BASE_MATERIALS = BASE_MATERIAL_GROUPS.flatMap((group) => group.items);


/** 解析 JSONL 文本：第一行（无 id）视为元数据行。 */
export function parseJsonl(text, source = 'core') {
  const entries = [];
  let meta = null;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (err) {
      continue;
    }
    if (meta === null && !obj.id) {
      meta = obj;
      continue;
    }
    if (!obj.id) continue;
    obj.__source = source;
    entries.push(obj);
  }
  return { meta, entries };
}

/**
 * @param {Array<{name:string,text:string}>} sources 按顺序覆盖（后加载的同 id 覆盖前者，并保留为候选路线）
 * @param {object} [options] { overrides: object[] }
 */
export function loadDatasetFromTexts(sources, options = {}) {
  const entries = [];
  for (const source of sources || []) {
    const { entries: parsed } = parseJsonl(source.text, source.name);
    entries.push(...parsed);
  }
  return createDataset(entries, options);
}
