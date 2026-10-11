/**
 * 树构建：把求解结果 + 供给分配展开成可折叠的树状图数据。
 *
 * 数字口径（界面会写明）：
 *   - 每个节点显示该物品在整个计划里**一共要合成多少次**（全局聚合值，不会重复计算）；
 *   - 节点下的每个子项显示**这条配方实际要投入多少**（已扣掉库存与上游余料）；
 *   - 被共用、但缺口为 0 的子项会标为「由库存/余料提供」，不参与采购。
 */

/**
 * @param {object} dataset
 * @param {object} solution solve() 的返回值
 * @param {object} allocation allocateSupply() 的返回值
 */
export function buildTree(dataset, solution, allocation, options = {}) {
  const maxDepth = options.maxDepth ?? 60;
  const maxNodes = options.maxNodes ?? 6000;

  const production = solution.produced || new Map();
  const routeById = solution.routeById || new Map(solution.routes.map((route) => [route.id, route]));
  const shortfallMap = new Map();
  for (const rawItem of solution.raw) shortfallMap.set(rawItem.id, rawItem);

  const parentKinds = new Map();
  for (const [consumerId, edges] of allocation.consumptionEdges) {
    for (const edge of edges) {
      if (!parentKinds.has(edge.source)) parentKinds.set(edge.source, new Map());
      const map = parentKinds.get(edge.source);
      const entry = map.get(consumerId) || { supplied: 0, short: 0 };
      entry[edge.kind === 'short' ? 'short' : 'supplied'] += edge.amount;
      map.set(consumerId, entry);
    }
  }

  let nodeCount = 0;
  let truncated = false;

  function makeNode(id, quantity, depth, path) {
    nodeCount += 1;
    if (nodeCount > maxNodes) truncated = true;

    const route = routeById.get(id);
    const variant = dataset.get(id);
    const rawItem = shortfallMap.get(id);
    const sharedBy = parentKinds.get(id)?.size || 0;

    const node = {
      id,
      name: dataset.name(id),
      quantity: Number.isInteger(quantity) ? quantity : Math.ceil(quantity),
      exact: quantity,
      depth,
      crafts: route ? route.crafts : 0,
      produced: production.get(id) || 0,
      output: route ? route.output : variant?.output || 1,
      machine: route ? route.machine : variant?.recipeType || '—',
      researchCost: variant?.researchCost ?? null,
      shared: sharedBy > 1,
      sharedFrom: sharedBy > 1 ? [...parentKinds.get(id).keys()].map((pid) => dataset.name(pid)) : [],
      leaf: false,
      truncated: false,
      leafKind: rawItem?.kind || (route ? 'crafted' : 'unknown'),
      shortfall: rawItem ? rawItem.count : 0,
      fromInventory: rawItem?.fromInventory || 0,
      fromSpare: rawItem?.fromSpare || 0,
      children: [],
    };

    const edges = allocation.consumptionEdges.get(id) || [];
    const hasEdges = edges.length > 0;
    if (truncated || depth >= maxDepth || !hasEdges) {
      node.leaf = true;
      if (!hasEdges && route && route.crafts > 0 && !rawItem) node.leafKind = 'crafted';
      return node;
    }

    // 稳定顺序：先按本配方里的材料顺序，再按数量
    const materialOrder = new Map((variant?.materials || []).map((m, index) => [m.material, index]));
    const sorted = [...edges].sort((a, b) => {
      const ai = materialOrder.has(a.source) ? materialOrder.get(a.source) : 999;
      const bi = materialOrder.has(b.source) ? materialOrder.get(b.source) : 999;
      if (a.kind !== b.kind) return a.kind === 'short' ? -1 : 1;
      return ai - bi || b.amount - a.amount;
    });

    for (const edge of sorted) {
      if (nodeCount > maxNodes) {
        node.truncated = true;
        break;
      }
      if (path.includes(edge.source)) {
        node.children.push({
          id: edge.source,
          name: dataset.name(edge.source),
          quantity: edge.amount,
          exact: edge.amount,
          depth: depth + 1,
          crafts: 0,
          produced: 0,
          output: 1,
          machine: '—',
          shared: false,
          sharedFrom: [],
          leaf: true,
          truncated: false,
          leafKind: 'cycle',
          shortfall: edge.amount,
          fromInventory: 0,
          fromSpare: 0,
          providedBy: edge.kind,
          children: [],
        });
        continue;
      }
      const child = makeNode(edge.source, edge.amount, depth + 1, path.concat(id));
      child.providedBy = edge.kind;
      node.children.push(child);
    }
    return node;
  }

  const roots = solution.targets.map((target) => {
    const node = makeNode(target.id, target.count, 0, []);
    node.isTarget = true;
    return node;
  });

  return { roots, truncated, nodeCount };
}

/** 采集清单：把树里的叶子按物品合并，得到"到底要弄到多少"。 */
export function collectLeaves(tree) {
  const map = new Map();
  const visit = (node) => {
    if (node.leaf) {
      if (node.leafKind === 'crafted' || node.leafKind === 'stock') return;
      const prev = map.get(node.id);
      if (prev) {
        prev.total += node.shortfall || node.quantity;
        prev.hits += 1;
      } else {
        map.set(node.id, {
          id: node.id,
          name: node.name,
          total: node.shortfall || node.quantity,
          hits: 1,
          kind: node.leafKind,
        });
      }
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const root of tree.roots) visit(root);
  return [...map.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh'));
}

/** 工序表：按拓扑序（自叶向根）给出"先做什么"，附机器与批次。 */
export function buildWorkOrder(solution) {
  return solution.routes
    .filter((route) => route.crafts > 0)
    .map((route, index) => ({
      step: index + 1,
      id: route.id,
      name: route.name,
      machine: route.machine,
      crafts: route.crafts,
      produced: route.produced,
      demand: route.demand,
      output: route.output,
      fromStock: route.fromStock,
      researchCost: route.researchCost ?? null,
      materials: route.materials,
    }));
}
