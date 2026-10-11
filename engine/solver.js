/**
 * 求解器：需求/供给的固定点迭代（叶 → 根一遍传播，多轮收敛）。
 *
 * 每一轮做三件事：
 *   1. 名义需求 gross：每个父配方按当前合成次数要投多少份（各父相加，共享材料只算一次）；
 *   2. 供给 available：库存 + 子树余料。余料 = 本轮产出 - 本轮被父配方吃掉的份数；
 *      因为子是先于父处理的，"自己产出的余料"可以在同一轮里垫给父配方；
 *   3. 净需求 net = max(0, gross - available)，合成次数 = ceil(net / 一次产出)。
 * 反复到 gross / crafts 稳定（DAG + 单调收敛，通常几轮就稳）。
 *
 * 这样同时满足：共享中间产物只算一次、逐级向上取整、库存先扣、余料复用。
 */

export function solve(dataset, options = {}) {
  const targets = (options.targets || []).filter((t) => t && t.id && t.count > 0);
  const baseSet = options.baseSet instanceof Set ? options.baseSet : new Set(options.baseSet || []);
  const recipeChoice = options.recipeChoice || {};
  const inventory = new Map();
  for (const [id, count] of Object.entries(options.inventory || {})) {
    const value = Number(count) || 0;
    if (value > 0) inventory.set(id, value);
  }

  function resolveVariant(id) {
    const list = dataset.variants(id);
    if (list.length === 0) return null;
    const wanted = recipeChoice[id];
    if (wanted) {
      const hit = list.find((v) => variantKey(v) === wanted) || list.find((v) => v.source === wanted);
      if (hit) return hit;
    }
    return list[0];
  }

  /** 没有配方、采集型、或用户指定为基础材料 → 采集终点（目标本身仍然会展开） */
  /**
   * 是不是"采集终点"（不再往下展开配方）。
   * 注意：目标物品**如果真的有可展开的配方**，即使命中基础材料名单也照常展开，
   * 否则你输入"铁粉 ×64"只会得到"去弄 64 个铁粉"，看不到它其实能用粉碎机做。
   */
  function isTerminal(id) {
    const variant = resolveVariant(id);
    const expandable = Boolean(variant && !variant.gather && variant.materials.length > 0);
    if (targetsWithDemand.has(id) && expandable) return false;
    if (baseSet.has(id)) return true;
    if (!variant) return true;
    return variant.gather || variant.materials.length === 0;
  }

  const targetsWithDemand = new Set(targets.map((target) => target.id));

  // ---- 建图 ----
  const children = new Map();
  const parentRefs = new Map();
  const added = new Set();

  function walk(id) {
    if (added.has(id)) return;
    added.add(id);
    if (isTerminal(id)) return;
    const variant = resolveVariant(id);
    if (!children.has(id)) children.set(id, new Set());
    for (const material of variant.materials) {
      children.get(id).add(material.material);
      if (!parentRefs.has(material.material)) parentRefs.set(material.material, new Set());
      parentRefs.get(material.material).add(id);
      walk(material.material);
    }
  }

  for (const target of targets) walk(target.id);

  // 拓扑序：叶在前、根在后
  const indegree = new Map();
  for (const id of added) indegree.set(id, parentRefs.get(id)?.size || 0);
  const queue = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);
  const order = [];
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i];
    order.push(id);
    for (const child of children.get(id) || []) {
      const next = (indegree.get(child) || 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  const unresolved = [...added].filter((id) => (indegree.get(id) || 0) > 0);
  const cycleSet = new Set(unresolved);

  const craftable = order.filter((id) => !isTerminal(id) && !cycleSet.has(id));
  const targetDemand = new Map();
  for (const target of targets) targetDemand.set(target.id, (targetDemand.get(target.id) || 0) + target.count);

  // ---- 固定点迭代：需求 → 次数（逐级向上取整），直到次数稳定 ----
  //
  // 口径说明（很重要）：
  //   合成次数只由"配方树 + 目标数量"决定，不参与库存抵扣。
  //   这样数字不会来回震荡，用户看到的树与工序表也永远是一致的。
  //   库存（inventory）只在最后结算时抵扣"要去采集的数量"，并在树上标注。
  let crafts = new Map(craftable.map((id) => [id, 0]));
  let gross = new Map(targetDemand);
  let produced = new Map();
  let excess = new Map();
  let consumed = new Map(targetDemand);
  let iterations = 0;
  let converged = false;
  const maxIterations = options.maxIterations ?? 60;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    iterations = iter + 1;

    // 1) 名义需求 = 目标 + 各父配方按当前次数要投的份数（共享材料只算一次）
    const nextGross = new Map(targetDemand);
    for (const id of craftable) {
      const count = crafts.get(id) || 0;
      if (count <= 0) continue;
      const variant = resolveVariant(id);
      for (const material of variant.materials) {
        const add = material.slotCount * count;
        if (add > 0) nextGross.set(material.material, (nextGross.get(material.material) || 0) + add);
      }
    }

    // 2) 自叶向根：需求 → 次数（逐级向上取整，余料回流给别的分支）
    const nextCrafts = new Map();
    const nextProduced = new Map();
    const nextExcess = new Map();
    for (const id of order) {
      if (isTerminal(id) || cycleSet.has(id)) {
        nextCrafts.set(id, 0);
        nextProduced.set(id, 0);
        nextExcess.set(id, 0);
        continue;
      }
      const variant = resolveVariant(id);
      const need = nextGross.get(id) || 0;
      const count = need > 0 ? Math.ceil(need / variant.output) : 0;
      const total = count * variant.output;
      nextCrafts.set(id, count);
      nextProduced.set(id, total);
      nextExcess.set(id, Math.max(0, total - need));
    }

    // 3) 本次实际消耗 = 各父配方投料 + 目标
    const nextConsumed = new Map(targetDemand);
    for (const id of craftable) {
      const count = nextCrafts.get(id) || 0;
      if (count <= 0) continue;
      const variant = resolveVariant(id);
      for (const material of variant.materials) {
        const total = material.slotCount * count;
        if (total > 0) nextConsumed.set(material.material, (nextConsumed.get(material.material) || 0) + total);
      }
    }

    // 4) 收敛判断：合成次数不再变化
    let stable = nextCrafts.size === crafts.size;
    if (stable) {
      for (const [id, count] of nextCrafts) {
        if ((crafts.get(id) || 0) !== count) {
          stable = false;
          break;
        }
      }
    }

    crafts = nextCrafts;
    gross = nextGross;
    produced = nextProduced;
    excess = nextExcess;
    consumed = nextConsumed;

    if (stable && iter > 0) {
      converged = true;
      break;
    }
  }

  // ---- 结算 ----
  // 采集清单 = 实际消耗 - 库存 -（自己产出的不算采集）。库存只影响采购量，不影响配方树。
  const raw = [];
  const missing = [];
  const usedInventory = [];

  for (const id of added) {
    if ((produced.get(id) || 0) > 0) continue;
    const demand = consumed.get(id) || 0;
    const stock = inventory.get(id) || 0;
    const fromStock = Math.min(stock, demand);
    const shortfall = Math.max(0, demand - fromStock);
    if (shortfall <= 0 && demand <= 0) continue;
    const variant = dataset.get(id);
    raw.push({
      id,
      name: dataset.name(id),
      count: Math.ceil(shortfall),
      exact: shortfall,
      demand,
      fromInventory: fromStock,
      fromSpare: 0,
      kind: cycleSet.has(id) ? 'cycle' : variant?.gather ? 'gather' : baseSet.has(id) ? 'base' : 'unknown',
      machine: variant?.recipeType || '—',
    });
    if (!variant && !baseSet.has(id)) missing.push({ id, name: dataset.name(id) });
  }

  for (const [id, stock] of inventory) {
    const used = Math.min(stock, consumed.get(id) || 0);
    if (used > 0) usedInventory.push({ id, name: dataset.name(id), used });
  }

  const routes = craftable.map((id) => {
    const variant = resolveVariant(id);
    const count = crafts.get(id) || 0;
    return {
      id,
      name: dataset.name(id),
      machine: variant.recipeType,
      output: variant.output,
      crafts: count,
      produced: produced.get(id) || 0,
      demand: gross.get(id) || 0,
      excess: excess.get(id) || 0,
      materials: variant.materials.map((m) => ({
        id: m.material,
        name: dataset.name(m.material),
        perCraft: m.slotCount,
        total: m.slotCount * count,
      })),
      research: variant.research,
      researchCost: variant.researchCost,
    };
  });

  const leftover = [];
  for (const [id, total] of produced) {
    if (total <= 0) continue;
    const over = total - (consumed.get(id) || 0);
    if (over > 0) leftover.push({ id, name: dataset.name(id), count: over });
  }
  leftover.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  raw.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));

  return {
    targets,
    raw,
    routes,
    routeById: new Map(routes.map((route) => [route.id, route])),
    leftover,
    usedInventory,
    missing,
    cycles: unresolved.map((id) => ({
      id,
      name: dataset.name(id),
      dependsOn: [...(parentRefs.get(id) || [])].map((r) => dataset.name(r)),
    })),
    order,
    need: gross,
    grossNeed: gross,
    produced,
    crafts,
    iterations,
    converged,
    graph: { children, parentRefs, added, order, cycleSet },
    resolveVariant,
    isTerminal,
    baseSet,
    recipeChoice,
  };
}

/**
 * 采集清单终值：以树的分配结果为准（树上每个分支实际拿了多少份），
 * 保证"采集清单 = 树状图里各分支之和"。
 */
export function settleRaw(dataset, solution, allocation) {
  const raw = [];
  for (const item of solution.raw) {
    const decided = allocation.shortfalls.get(item.id);
    const shortfall = decided === undefined ? item.exact : Math.min(decided, item.exact);
    if (shortfall <= 0) continue;
    raw.push({ ...item, count: Math.ceil(shortfall), exact: shortfall });
  }
  raw.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  return raw;
}

/**
 * 供给分配：按拓扑序自上而下，把每个"生产节点"的余料精确分配给需要它的父配方。
 * 这样树图上每个分支的数字都是精确的，同一份余料也不会被两个分支重复认领。
 */
export function allocateSupply(dataset, solution) {
  const pool = new Map();
  const consumptionEdges = new Map();
  const supplyEdges = new Map();
  const shortfalls = new Map();

  for (const id of solution.order) consumptionEdges.set(id, []);

  for (const consumerId of solution.order) {
    const route = solution.routeById.get(consumerId);
    const variant = solution.resolveVariant(consumerId);
    if (!route || !variant || route.crafts <= 0) continue;

    for (const material of variant.materials) {
      const needed = material.slotCount * route.crafts;
      if (needed <= 0) continue;
      const available = pool.get(material.material) || 0;
      const used = Math.min(available, needed);
      if (used > 0) {
        pool.set(material.material, available - used);
        addEdge(consumptionEdges, consumerId, { source: material.material, amount: used, kind: 'supplied' });
        addEdge(supplyEdges, material.material, { consumer: consumerId, amount: used });
      }
      const short = needed - used;
      if (short > 0) {
        shortfalls.set(material.material, (shortfalls.get(material.material) || 0) + short);
        addEdge(consumptionEdges, consumerId, { source: material.material, amount: short, kind: 'short' });
      }
    }

    const over = route.excess || 0;
    if (over > 0) pool.set(consumerId, (pool.get(consumerId) || 0) + over);
  }

  const leftover = [...pool.entries()]
    .filter(([, amount]) => amount > 0)
    .map(([id, amount]) => ({ id, name: dataset.name(id), count: amount, kind: 'leftover' }));

  return { consumptionEdges, supplyEdges, leftover, shortfalls };
}

function addEdge(map, key, edge) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(edge);
}

export function variantKey(variant) {
  return `${variant.source}:${variant.recipeType}:${variant.output}:${variant.materials
    .map((m) => `${m.material}x${m.slotCount}`)
    .join(',')}`;
}











