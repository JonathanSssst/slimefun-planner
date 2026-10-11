/**
 * 数据集：把配方 JSONL 条目整理成可查询的索引。
 *
 * 数据条目格式（来源：slimefunAsstOL，已实测）：
 *   { id, name, recipeType, recipe: [ {material,name} | null x9 ], output, sortid, research?, researchCost? }
 *
 * 本模块只做"整理与索引"，不做环境相关 IO（浏览器/Node 各自负责取数据）。
 */

/** 视为「去采集」而不是「去合成」的配方类型。 */
export const BASE_TYPES = new Set([
  '生物掉落',
  '交易获得',
  '自然资源开采机',
  '淘金盘',
  '钓鱼',
  '考古',
  'slimefun:null',
  'null',
  '',
]);

/** 无实际配方（9 格全空）的条目，同样视为采集终点。 */
export function isEmptyRecipe(entry) {
  return !(entry.recipe || []).some((slot) => slot && slot.material);
}

/**
 * 把一个条目的 9 格配方压成 [{ material, name, slotCount }]。
 * 注意：铁粉、锭这类材料在一张配方里会占多个格子，必须按格计数，不能去重。
 */
export function slotsToMaterials(recipe) {
  const map = new Map();
  for (const slot of recipe || []) {
    if (!slot || !slot.material) continue;
    const key = slot.material;
    const found = map.get(key);
    if (found) {
      found.slotCount += 1;
    } else {
      map.set(key, { material: key, name: slot.name || key, slotCount: 1 });
    }
  }
  return [...map.values()];
}

function normalizeVariant(entry, source) {
  const materials = slotsToMaterials(entry.recipe);
  return {
    id: entry.id,
    name: entry.name || entry.id,
    recipeType: entry.recipeType || '',
    machine: entry.recipeType || '',
    output: Math.max(1, Number(entry.output) || 1),
    materials,
    research: entry.research || null,
    researchCost: entry.researchCost ?? null,
    sortid: entry.sortid ?? null,
    source: source || entry.__source || 'core',
    /** 采集型条目（生物掉落/交易/开采机/空配方） */
    gather: BASE_TYPES.has(entry.recipeType || '') || isEmptyRecipe(entry),
    overridden: Boolean(entry.__overridden),
  };
}

/**
 * 构建数据集。
 * @param {object[]} entries  原始配方条目（可来自多个 jsonl，后者覆盖同 id 的前者）
 * @param {object}   [options]
 * @param {object[]} [options.overrides] 用户补录：{ id, name?, recipeType?, output?, materials?: {MAT:count}, recipe?: slots[], disable?: true }
 */
export function createDataset(entries, options = {}) {
  const byId = new Map();
  const variantsById = new Map();

  const pushVariant = (variant) => {
    if (!variantsById.has(variant.id)) variantsById.set(variant.id, []);
    variantsById.get(variant.id).push(variant);
  };

  for (const entry of entries || []) {
    if (!entry || !entry.id) continue;
    const variant = normalizeVariant(entry);
    pushVariant(variant);
    byId.set(variant.id, variant);
  }

  const unknownMaterials = new Map();

  for (const raw of options.overrides || []) {
    if (!raw || !raw.id) continue;
    const id = raw.id;
    if (raw.disable) {
      byId.delete(id);
      variantsById.delete(id);
      continue;
    }
    const prev = byId.get(id);
    const materials = [];
    if (raw.materials && typeof raw.materials === 'object' && !Array.isArray(raw.materials)) {
      for (const [material, count] of Object.entries(raw.materials)) {
        materials.push({ material, name: raw.materialNames?.[material] || material, slotCount: Math.max(1, Number(count) || 1) });
      }
    } else if (Array.isArray(raw.recipe)) {
      materials.push(...slotsToMaterials(raw.recipe));
    }
    const variant = {
      id,
      name: raw.name || prev?.name || id,
      recipeType: raw.recipeType ?? prev?.recipeType ?? '自定义',
      machine: raw.recipeType ?? prev?.machine ?? '自定义',
      output: Math.max(1, Number(raw.output) || prev?.output || 1),
      materials,
      research: prev?.research ?? null,
      researchCost: raw.researchCost ?? prev?.researchCost ?? null,
      sortid: raw.sortid ?? prev?.sortid ?? null,
      source: 'override',
      gather: Boolean(raw.gather),
      overridden: true,
      variantLabel: raw.variantLabel || '自定义配方',
      disabled: false,
    };
    if (raw.appendVariant) pushVariant(variant);
    else {
      variantsById.set(id, [variant]);
      byId.set(id, variant);
    }
  }

  // 重复 id 的后续条目作为「候选路线」保留，第一条件为主路线
  for (const [id, list] of variantsById) {
    byId.set(id, list[0]);
  }

  const names = new Map();
  for (const [id, list] of variantsById) names.set(id, list[0].name);

  // 收集只在配方里出现过、但没有自身条目的材料（原版物品 / 采集物）
  for (const [, list] of variantsById) {
    for (const variant of list) {
      for (const m of variant.materials) {
        if (!names.has(m.material)) {
          names.set(m.material, m.name || m.material);
          unknownMaterials.set(m.material, m.name || m.material);
        }
      }
    }
  }

  return {
    byId,
    variantsById,
    names,
    /** 只在配方中出现、无自身配方的材料 id -> 名称 */
    unknownMaterials,

    /** 取某物品的主路线 */
    get(id) {
      return byId.get(id) || null;
    },
    /** 取某物品的全部候选路线 */
    variants(id) {
      return variantsById.get(id) || [];
    },
    name(id) {
      return names.get(id) || id;
    },
    has(id) {
      return byId.has(id);
    },
    /** 是否应停止展开：没有配方、或配方本身是采集型、或在基础材料名单中 */
    isTerminal(id, baseSet) {
      if (baseSet && baseSet.has(id)) return true;
      const variant = byId.get(id);
      if (!variant) return true;
      return variant.gather || variant.materials.length === 0;
    },
    get size() {
      return byId.size;
    },
    /** 模糊搜索：中文名或 id 命中 */
    search(query, limit = 30) {
      const q = String(query || '').trim().toLowerCase();
      if (!q) return [];
      const scored = [];
      for (const [id, list] of variantsById) {
        const variant = list[0];
        const name = variant.name || '';
        const shortId = id.includes(':') ? id.split(':').slice(1).join(':') : id;
        let score = -1;
        if (id.toLowerCase() === q || shortId.toLowerCase() === q || name === query) score = 100;
        else if (name.toLowerCase().startsWith(q) || shortId.toLowerCase().startsWith(q)) score = 80;
        else if (name.toLowerCase().includes(q)) score = 60;
        else if (shortId.toLowerCase().includes(q)) score = 40;
        if (score > 0) scored.push({ id, name, recipeType: variant.recipeType, score });
      }
      scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh'));
      return scored.slice(0, limit);
    },
  };
}

/**
 * 估算每条路线消耗多少「采集终点」材料，返回单位成本向量。
 * 用于多路线自动择优（默认选最省生料）。存在环或嵌套过深时退化为保守值。
 */
export function computeVariantCosts(dataset, baseSet, options = {}) {
  const maxDepth = options.maxDepth ?? 24;
  const includeGatherAsBase = options.includeGatherAsBase !== false;
  const costs = new Map();
  const visiting = new Set();

  function costOf(id, depth) {
    if (costs.has(id)) return costs.get(id);
    if (depth > maxDepth) return null;
    if (visiting.has(id)) return null; // 环：视为不可估算

    const variant = dataset.get(id);
    if (!variant) {
      const leaf = new Map([[id, 1]]);
      costs.set(id, leaf);
      return leaf;
    }
    if ((baseSet && baseSet.has(id)) || (includeGatherAsBase && variant.gather) || variant.materials.length === 0) {
      const leaf = new Map([[id, 1]]);
      costs.set(id, leaf);
      return leaf;
    }

    visiting.add(id);
    const perCraft = new Map();
    let ok = true;
    for (const material of variant.materials) {
      const sub = costOf(material.material, depth + 1);
      if (!sub) {
        ok = false;
        break;
      }
      for (const [leaf, amount] of sub) {
        perCraft.set(leaf, (perCraft.get(leaf) || 0) + amount * material.slotCount);
      }
    }
    visiting.delete(id);
    if (!ok) return null;

    const unit = new Map();
    for (const [leaf, amount] of perCraft) unit.set(leaf, amount / variant.output);
    costs.set(id, unit);
    return unit;
  }

  for (const id of dataset.variantsById.keys()) costOf(id, 0);
  return costs;
}
