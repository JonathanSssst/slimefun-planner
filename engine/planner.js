/**
 * 统一入口：目标 → 采集清单 + 树状图 + 工序表。
 */

import { solve, allocateSupply, settleRaw } from './solver.js';
import { buildTree, buildWorkOrder, collectLeaves } from './tree.js';
import { chooseVariants } from './variants.js';

/**
 * @param {object} dataset createDataset 的返回值
 * @param {object} options
 * @param {Array<{id:string,count:number}>} options.targets
 * @param {string[]} [options.baseMaterials] 采集终点名单
 * @param {Object<string,number>} [options.inventory] 已有库存
 * @param {Object<string,string>} [options.recipeChoice] 手动指定路线（itemId -> 路线 key）
 * @param {boolean} [options.autoSelect=true] 多路线自动择优
 */
export function plan(dataset, options = {}) {
  const baseSet = new Set(options.baseMaterials || []);
  const recipeChoice = { ...(options.recipeChoice || {}) };
  const autoSelect = options.autoSelect !== false;

  let variantReport = null;
  if (autoSelect) {
    const result = chooseVariants(dataset, baseSet, options.variantOptions || {});
    variantReport = result.details;
    for (const [id, key] of Object.entries(result.choice)) {
      if (!recipeChoice[id]) recipeChoice[id] = key;
    }
  }

  const solution = solve(dataset, {
    targets: options.targets,
    baseSet,
    inventory: options.inventory,
    recipeChoice,
  });  solution.routeById = new Map(solution.routes.map((route) => [route.id, route]));

  const allocation = allocateSupply(dataset, solution);

  // 用分配结果回填"实际还差多少"，再结算采集清单
  solution.shortfall = allocation.shortfalls;
  solution.raw = settleRaw(dataset, solution, allocation);

  const tree = buildTree(dataset, solution, allocation, options.treeOptions || {});
  const workOrder = buildWorkOrder(solution);
  const leaves = collectLeaves(tree);

  // 采集清单：raw（真缺口）+ 循环依赖提示
  const raw = solution.raw.map((item) => ({
    id: item.id,
    name: item.name,
    count: item.count,
    exact: item.exact,
    demand: item.demand,
    kind: item.kind,
    machine: item.machine,
    fromInventory: item.fromInventory,
    fromSpare: item.fromSpare,
  }));

  const leftover = (allocation.leftover || [])
    .filter((item) => item.count > 0)
    .map((item) => ({ id: item.id, name: item.name, count: item.count }))
    .sort((a, b) => b.count - a.count);

  return {
    ...solution,
    allocation,
    leftover,
    tree,
    leaves,
    raw,
    workOrder,
    variantReport,
    summary: {
      targetCount: options.targets?.length || 0,
      rawKinds: raw.length,
      rawTotal: raw.reduce((sum, item) => sum + item.count, 0),
      craftSteps: workOrder.length,
      machines: [...new Set(workOrder.map((step) => step.machine))].length,
      missing: solution.missing.length,
      cycles: solution.cycles.length,
      leftoverKinds: leftover.length,
    },
  };
}
