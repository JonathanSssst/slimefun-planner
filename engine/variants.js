/**
 * 多路线择优：默认选「最省生料」的那条路线。
 *
 * 做法：在全图上做固定点迭代，求出每条路线的单位成本（消耗多少份采集终点材料），
 * 每个物品取其成本最低的候选路线；没有候选的物品成本为 1。
 * 这只是"够用且稳定"的启发式——不是整数规划，但对"选粉碎还是洗矿"这类比较已经足够。
 */

import { variantKey } from './solver.js';

export function computeUnitCosts(dataset, baseSet, options = {}) {
  const iterations = options.iterations ?? 24;
  const base = baseSet instanceof Set ? baseSet : new Set(baseSet || []);
  const costs = new Map();

  for (const id of dataset.variantsById.keys()) {
    const variant = dataset.get(id);
    if (!variant || base.has(id) || variant.gather || variant.materials.length === 0) {
      costs.set(id, 1);
    } else {
      costs.set(id, Number.POSITIVE_INFINITY);
    }
  }

  for (let iter = 0; iter < iterations; iter += 1) {
    let changed = false;
    for (const [id, list] of dataset.variantsById) {
      if (base.has(id)) continue;
      let best = costs.get(id);
      for (const variant of list) {
        if (variant.gather || variant.materials.length === 0) {
          if (best === null || best === undefined || best > 1) best = 1;
          continue;
        }
        let sum = 0;
        let ok = true;
        for (const material of variant.materials) {
          const child = costs.get(material.material);
          const childCost = child === undefined ? 1 : child;
          if (!Number.isFinite(childCost)) {
            ok = false;
            break;
          }
          sum += childCost * material.slotCount;
        }
        if (!ok) continue;
        const unit = sum / variant.output;
        if (unit < best) best = unit;
      }
      if (best !== costs.get(id)) {
        costs.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 仍然算不出来的（纯环），给一个保守值
  for (const [id, cost] of costs) {
    if (!Number.isFinite(cost)) costs.set(id, 1);
  }
  return costs;
}

/**
 * 为每个有多条路线的物品挑一条最省的路线。
 * @returns {{choice: Object<string,string>, details: Array}}
 */
export function chooseVariants(dataset, baseSet, options = {}) {
  const costs = computeUnitCosts(dataset, baseSet, options);
  const choice = {};
  const details = [];

  for (const [id, list] of dataset.variantsById) {
    if (list.length < 2) continue;
    const scored = list.map((variant) => {
      let total = 0;
      for (const material of variant.materials) total += (costs.get(material.material) ?? 1) * material.slotCount;
      return { variant, unitCost: total / variant.output, key: variantKey(variant) };
    });
    scored.sort((a, b) => a.unitCost - b.unitCost);
    choice[id] = scored[0].key;
    details.push({
      id,
      name: dataset.name(id),
      picked: scored[0].variant.recipeType,
      pickedCost: scored[0].unitCost,
      candidates: scored.map((s) => ({
        key: s.key,
        machine: s.variant.recipeType,
        output: s.variant.output,
        unitCost: s.unitCost,
        materials: s.variant.materials.map((m) => `${dataset.name(m.material)}x${m.slotCount}`),
      })),
    });
  }

  return { choice, details, costs };
}
