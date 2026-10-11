/**
 * 物品详情：把数据集里的一条配方整理成"能直接画出来"的结构 +
 * 图标解析 + 用途/来源统计。纯数据，不碰 DOM，方便单测。
 */

/** 常见的机器配方在游戏里就是 3x3 网格（增强型工作台、魔法工作台、盔甲锻造台…） */
const GRID_TYPES = new Set([
  '增强型工作台', '魔法工作台', '盔甲锻造台', '古代祭坛', '多方块结构',
  'slimefun:food_fabricator', 'slimefun:food_composter',
]);

/**
 * 把配方整理成网格显示用的布局。
 * 兼容两种输入：
 *   - 原始条目（带 9 格 recipe 数组）→ 能看出摆位，做居中美化；
 *   - 归一化后的路线（带 materials: [{material,name,slotCount}]）→ 顺序铺格子。
 * 数据里的槽位是固定 9 格（null 表示空），这里只做"居中对齐"，
 * 不猜测配方几何形状——摆错位置比不摆更糟。
 */
export function layoutRecipe(entry) {
  let slots = (entry?.recipe || []).slice(0, 9);
  if (slots.length === 0 && Array.isArray(entry?.materials)) {
    slots = [];
    for (const material of entry.materials) {
      const id = material.id || material.material;
      for (let i = 0; i < Math.max(1, material.slotCount || 1); i += 1) {
        slots.push({ id, material: id, name: material.name });
      }
    }
  }
  while (slots.length < 9) slots.push(null);

  let rows = 3;
  let cols = 3;

  // 多方块机器（冶炼炉/洗矿机…）实际是"投料口"列表，不是 3x3 摆位
  const isMachineList = !GRID_TYPES.has(entry?.recipeType || '');

  if (!isMachineList) {
    const filled = slots.map((slot, index) => (slot ? index : -1)).filter((index) => index >= 0);
    const indices = new Set(filled);
    const inRow = (row) => [0, 1, 2].every((col) => indices.has(row * 3 + col));
    const inCol = (col) => [0, 1, 2].every((row) => indices.has(row * 3 + col));

    if (filled.length === 4 && indices.has(0) && indices.has(1) && indices.has(3) && indices.has(4)) {
      rows = 2; cols = 2; // 2x2 形状，居左上即可
    } else if (filled.length === 3 && (inRow(0) || inRow(1))) {
      rows = 1; cols = 3;
    } else if (filled.length === 3 && (inCol(0) || inCol(1))) {
      rows = 3; cols = 1;
    }
  }

  const grid = [];
  for (let row = 0; row < rows; row += 1) {
    const line = [];
    for (let col = 0; col < cols; col += 1) {
      line.push(slots[row * 3 + col] || null);
    }
    grid.push(line);
  }

  const materials = [];
  const seen = new Map();
  slots.forEach((slot) => {
    if (!slot || !slot.material) return;
    const found = seen.get(slot.material);
    if (found) {
      found.slotCount += 1;
      return;
    }
    const entryItem = {
      id: slot.id || slot.material,
      material: slot.material,
      name: slot.name || slot.material,
      slotCount: 1,
    };
    seen.set(slot.material, entryItem);
    materials.push(entryItem);
  });

  return {
    rows,
    cols,
    grid,
    /** true = 每个格子代表一份投料（机器/多方块），false = 有明确摆位 */
    isMachineList,
    materials,
    totalSlots: slots.filter(Boolean).length,
  };
}

/** 该物品的一次合成产出几个 */
export function outputOf(entry) {
  return Math.max(1, Number(entry?.output) || 1);
}

/**
 * 生成物品详情（配方 + 用途）。需要在 dataset 上做一次全表扫描来统计"用途"，
 * 所以外部可以把索引缓存起来。
 */
export function buildUsageIndex(dataset) {
  const usedBy = new Map(); // materialId -> Set<物品id>
  for (const [id, list] of dataset.variantsById) {
    const variant = list[0];
    for (const material of variant.materials) {
      if (!usedBy.has(material.material)) usedBy.set(material.material, new Set());
      usedBy.get(material.material).add(id);
    }
  }
  return usedBy;
}

/**
 * @param {object} dataset
 * @param {string} id
 * @param {Map} usageIndex buildUsageIndex 的结果
 */
export function describeItem(dataset, id, usageIndex) {
  const variants = dataset.variants(id) || [];
  const primary = variants[0] || null;
  const name = dataset.name(id);

  const usedBy = [...(usageIndex?.get(id) || [])]
    .filter((other) => other !== id)
    .map((other) => ({ id: other, name: dataset.name(other) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  if (!primary) {
    return {
      id,
      name,
      hasRecipe: false,
      kind: 'unknown',
      variants: [],
      layout: null,
      output: 1,
      usedBy,
    };
  }

  return {
    id,
    name,
    hasRecipe: true,
    kind: primary.gather ? 'gather' : 'craft',
    recipeType: primary.recipeType,
    research: primary.research || null,
    researchCost: primary.researchCost ?? null,
    output: outputOf(primary),
    layout: layoutRecipe(primary),
    /** 候选路线（有些物品有多条，界面上让用户切换） */
    variants: variants.map((variant) => ({
      key: variantKeyOf(variant),
      recipeType: variant.recipeType,
      output: outputOf(variant),
      researchCost: variant.researchCost ?? null,
      source: variant.source,
      layout: layoutRecipe(variant),
    })),
    usedBy,
  };
}

export function variantKeyOf(variant) {
  return `${variant.source}:${variant.recipeType}:${variant.output}:${variant.materials
    .map((m) => `${m.material}x${m.slotCount}`)
    .join(',')}`;
}

// ---------------------------------------------------------------- 图标

/**
 * 图标解析（三级优先）：
 *   1. 用户自备覆盖（data/icons.json 的 overrides）；
 *   2. 粘液科技物品：data/icon-map.json 里的公开镜像地址（按物品 ID 命名，来自官方资源包仓库）；
 *   3. 原版物品：mcmeta 公开镜像里的贴图（item 优先，block 兜底）。
 * 都没有就回退成按名字生成的彩色徽章。仓库不打包任何 Mojang / Slimefun 素材，只存映射。
 *
 * @param {string} id
 * @param {object} [options]
 * @param {boolean} [options.enabled=true]
 * @param {object} [options.overrides] 用户覆盖：{ "ITEM_ID": "路径或URL" }
 * @param {object} [options.iconMap] 粘液物品映射：{ "simefun4:IRON_DUST": "https://..." }
 * @param {string} [options.cdnBase] 原版贴图镜像前缀
 */
export function resolveIcon(id, options = {}) {
  const enabled = options.enabled !== false;
  const overrides = options.overrides || {};
  const iconMap = options.iconMap || {};
  const raw = String(id || '');

  const custom = overrides[raw];
  if (custom) {
    return { url: custom, fallbackText: firstChar(raw), tone: toneOf(raw), isOverride: true };
  }

  if (!enabled) {
    return { url: null, fallbackText: firstChar(raw), tone: toneOf(raw) };
  }

  if (iconMap[raw]) {
    return { url: iconMap[raw], fallbackText: firstChar(raw), tone: toneOf(raw), fromIconMap: true };
  }

  const isSlimefun = raw.includes(':') && !raw.startsWith('minecraft:');
  if (isSlimefun) {
    return { url: null, fallbackText: firstChar(raw), tone: toneOf(raw) };
  }

  const path = raw.replace(/^minecraft:/, '').toLowerCase();
  if (!/^[a-z0-9_]+$/.test(path)) {
    return { url: null, fallbackText: firstChar(raw), tone: toneOf(raw) };
  }
  const base = options.cdnBase || 'https://raw.githubusercontent.com/misode/mcmeta/assets/assets/minecraft/textures';
  return {
    url: `${base}/item/${path}.png`,
    /** 找不到 item 贴图时退回方块贴图（很多"物品"其实是方块） */
    fallbackUrl: `${base}/block/${path}.png`,
    fallbackText: firstChar(raw),
    tone: toneOf(raw),
  };
}

function firstChar(id) {
  const withoutNamespace = String(id).includes(':') ? String(id).split(':').pop() : String(id);
  return (withoutNamespace[0] || '?').toUpperCase();
}

/** 用 id 稳定地生成一个 0~7 的色号，保证同一物品颜色固定 */
export function toneOf(id) {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash % 8;
}
