/**
 * 网页版入口：加载数据 → 组装界面 → 调用引擎算配方树。
 */

import { loadDatasetFromTexts, DEFAULT_BASE_MATERIALS, BASE_MATERIAL_GROUPS } from '../engine/data.js';
import { plan } from '../engine/planner.js';
import { describeItem, buildUsageIndex, resolveIcon } from '../engine/recipe-view.js';

const CORE_FILE = 'recipes.core.jsonl';
/** 仓库自带的补录（版主维护的公共补录，任何人拉下来都能用） */
const BUILTIN_OVERRIDES_FILE = 'data/overrides.json';
/** 自定义物品图标覆盖表 */
const ICONS_FILE = 'data/icons.json';
/** 粘液科技物品图标映射（由 tools/build-icon-map.mjs 生成，只存映射不存素材） */
const ICON_MAP_FILE = 'data/icon-map.json';
/** 本地图标缓存索引（由 tools/extract-local-icons.mjs 从本机资源包抽取，素材不入库） */
const ICON_CACHE_FILE = 'data/icons/icon-cache.json';

const STORAGE_KEY = 'slimefun-planner-settings-v1';
const LOCAL_OVERRIDES_KEY = 'slimefun-planner-overrides-v1';

const state = {
  dataset: null,
  result: null,
  /** 目标清单：[{ id, count }]，由选框添加，避免手打名称出错 */
  targetList: [],
  baseMaterials: new Set(DEFAULT_BASE_MATERIALS),
  inventoryText: '',
  overrides: [],
  localOverrides: [],
  recipeChoice: {},
  autoSelect: true,
  addonFiles: [],
  theme: 'light',
  /** 采集清单粒度：'1'=只到直接投料，'2'/'3'=再展开几层，'all'=一路展开到生料 */
  materialDepth: '1',
  /** 物品图标开关与自定义覆盖 */
  iconsEnabled: true,
  iconOverrides: {},
  iconMap: {},
  iconCache: {},
  /** 用途索引（材料 -> 哪些物品会用到它） */
  usageIndex: null,
  /** 配方查看页当前选中的物品 */
  recipeFocus: null,
};

const $ = (selector) => document.querySelector(selector);

let coreText = '';

/** 判断是否在静态托管（GitHub Pages 等没有后端）环境下运行 */
function isStaticHost() {
  if (typeof location === 'undefined') return true;
  return !/^127\.0\.0\.1$|^localhost$/.test(location.hostname || '');
}

// ---------------------------------------------------------------- 数据加载

async function fetchText(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} 读取失败（HTTP ${response.status}）`);
  return response.text();
}

function readLocalOverrides() {
  try {
    const raw = localStorage.getItem(LOCAL_OVERRIDES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[overrides] 本地补录损坏，已忽略', err);
    return [];
  }
}

function writeLocalOverrides(list) {
  try {
    localStorage.setItem(LOCAL_OVERRIDES_KEY, JSON.stringify(list));
    return true;
  } catch (err) {
    console.warn('[overrides] 本地补录保存失败', err);
    return false;
  }
}

async function loadData() {
  coreText = await fetchText(`data/${CORE_FILE}`);
  const sources = [{ name: CORE_FILE, text: coreText }];
  const loadedAddons = [];
  for (const name of state.addonFiles) {
    try {
      const text = await fetchText(`data/recipes.addons/${name}.jsonl`);
      sources.push({ name, text });
      loadedAddons.push(name);
    } catch (err) {
      console.warn('[addon] 跳过', name, err.message);
    }
  }

  const builtin = await readBuiltinOverrides();
  state.localOverrides = readLocalOverrides();
  state.overrides = mergeOverrides(builtin, state.localOverrides);

  state.dataset = loadDatasetFromTexts(sources, { overrides: state.overrides });
  state.usageIndex = buildUsageIndex(state.dataset);
  return loadedAddons;
}

/** 读取自定义图标覆盖表（data/icons.json）与粘液物品映射（data/icon-map.json） */
async function readIconConfig() {
  try {
    const parsed = JSON.parse((await fetchText(ICONS_FILE)).replace(/^\uFEFF/, ''));
    state.iconOverrides = (parsed && typeof parsed.overrides === 'object' && parsed.overrides) || {};
    if (typeof parsed?.enabled === 'boolean') state.iconsEnabled = parsed.enabled;
  } catch (err) {
    console.warn('[icons] 读取失败，按"无覆盖"处理', err.message);
    state.iconOverrides = {};
  }
  try {
    const map = JSON.parse((await fetchText(ICON_MAP_FILE)).replace(/^\uFEFF/, ''));
    state.iconMap = map && typeof map === 'object' ? map : {};
  } catch (err) {
    console.warn('[icons] 映射表读取失败，粘液物品将显示首字母徽章', err.message);
    state.iconMap = {};
  }
  try {
    const cache = JSON.parse((await fetchText(ICON_CACHE_FILE)).replace(/^\uFEFF/, ''));
    state.iconCache = cache && typeof cache === 'object' ? cache : {};
  } catch (err) {
    // 没跑过抽取脚本时属于正常情况，静默走在线映射
    state.iconCache = {};
  }
}

/** 仓库自带的公共补录（版主维护，所有人共享） */
async function readBuiltinOverrides() {
  try {
    const parsed = JSON.parse((await fetchText(BUILTIN_OVERRIDES_FILE)).replace(/^\uFEFF/, ''));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[overrides] 读取公共补录失败，按空处理', err.message);
    return [];
  }
}

/** 改完补录后重建数据集（只吃核心数据，附属沿用上次加载状态） */
function createDatasetWithOverrides(overrides) {
  return loadDatasetFromTexts([{ name: CORE_FILE, text: coreText }], { overrides });
}

/** 同一个 id 时本地补录覆盖公共补录 */
function mergeOverrides(builtin, local) {
  const map = new Map();
  for (const item of builtin) if (item && item.id) map.set(item.id, item);
  for (const item of local) if (item && item.id) map.set(item.id, item);
  return [...map.values()];
}


function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (Array.isArray(saved.baseMaterials) && saved.baseMaterials.length > 0) {
      state.baseMaterials = new Set(saved.baseMaterials);
    }
    if (typeof saved.inventoryText === 'string') state.inventoryText = saved.inventoryText;
    if (Array.isArray(saved.addonFiles)) state.addonFiles = saved.addonFiles;
    if (typeof saved.autoSelect === 'boolean') state.autoSelect = saved.autoSelect;
    if (Array.isArray(saved.targetList)) state.targetList = normalizeTargetList(saved.targetList);
    if (saved.theme === 'dark' || saved.theme === 'light') state.theme = saved.theme;
    if (typeof saved.materialDepth === 'string') state.materialDepth = saved.materialDepth;
    if (typeof saved.iconsEnabled === 'boolean') state.iconsEnabled = saved.iconsEnabled;
  } catch (err) {
    console.warn('[settings] 读取失败', err);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      baseMaterials: [...state.baseMaterials],
      inventoryText: state.inventoryText,
      addonFiles: state.addonFiles,
      autoSelect: state.autoSelect,
      targetList: state.targetList,
      theme: state.theme,
      materialDepth: state.materialDepth,
      iconsEnabled: state.iconsEnabled,
    }));
  } catch (err) {
    console.warn('[settings] 保存失败', err);
  }
}

function normalizeTargetList(list) {
  const out = [];
  for (const item of list || []) {
    if (!item || typeof item.id !== 'string') continue;
    const count = Math.max(1, Math.floor(Number(item.count) || 1));
    const existing = out.find((entry) => entry.id === item.id);
    if (existing) existing.count += count;
    else out.push({ id: item.id, count });
  }
  return out;
}

// ---------------------------------------------------------------- 主题

function applyTheme() {
  const theme = state.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  const icon = $('#themeIcon');
  const label = $('#themeLabel');
  if (icon) icon.textContent = theme === 'dark' ? '🌙' : '☀';
  if (label) label.textContent = theme === 'dark' ? '深色' : '浅色';
}

/** 读取 URL 上的 ?theme=dark|light，方便直接分享指定主题的链接 */
function themeFromUrl() {
  try {
    const value = new URLSearchParams(location.search).get('theme');
    return value === 'dark' || value === 'light' ? value : null;
  } catch (err) {
    return null;
  }
}

function setupTheme() {
  applyTheme();
  $('#themeToggle').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    saveSettings();
  });
}

// ---------------------------------------------------------------- 输入解析

function parseInventory(text) {
  const inventory = {};
  const unknown = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(.*?)\s*[=:：]\s*(\d+)$/) || line.match(/^(\S+)\s+(\d+)$/);
    if (!match) {
      unknown.push(line);
      continue;
    }
    const query = match[1].trim();
    const count = Number(match[2]);
    if (!query || !Number.isFinite(count) || count <= 0) {
      unknown.push(line);
      continue;
    }
    const id = resolveItemId(query);
    if (!id) {
      unknown.push(query);
      continue;
    }
    inventory[id] = (inventory[id] || 0) + count;
  }
  return { inventory, unknown };
}

function resolveItemId(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return null;
  if (state.dataset.has(trimmed)) return trimmed;
  const upper = `simefun4:${trimmed.toUpperCase().replace(/\s+/g, '_')}`;
  if (state.dataset.has(upper)) return upper;
  if (state.dataset.has(trimmed.toUpperCase())) return trimmed.toUpperCase();
  const hits = state.dataset.search(trimmed, 1);
  return hits.length > 0 ? hits[0].id : null;
}

/** 批量文本 → 目标清单（名称对不上就报出来，不猜） */
function parseTargets(text) {
  const targets = [];
  const unknown = [];
  for (const rawLine of String(text || '').split(/[\n,，;；]+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(.*?)\s*(?:[x×*]\s*)?(\d+)\s*$/i);
    const query = (match ? match[1] : line).trim();
    const count = match && match[2] ? Number(match[2]) : 1;
    if (!query) continue;
    const id = resolveItemId(query);
    if (!id) {
      unknown.push(query);
      continue;
    }
    const existing = targets.find((target) => target.id === id);
    if (existing) existing.count += count;
    else targets.push({ id, count });
  }
  return { targets, unknown };
}

// ---------------------------------------------------------------- 计算

function compute() {
  if (!state.dataset) return null;
  const { inventory, unknown } = parseInventory(state.inventoryText);
  const result = plan(state.dataset, {
    targets: state.targetList,
    baseMaterials: [...state.baseMaterials],
    inventory,
    autoSelect: state.autoSelect,
    recipeChoice: state.recipeChoice,
    materialDepth: state.materialDepth === 'all' ? undefined : Number(state.materialDepth),
  });
  result.inventoryUsed = inventory;
  result.unknownInventory = unknown;
  return result;
}

// ---------------------------------------------------------------- 渲染

function renderDatasetInfo(addonCount) {
  const total = state.dataset.size;
  $('#datasetInfo').innerHTML = `配方条目 <b>${total}</b> 条${addonCount ? ` · 附属 ${addonCount} 个` : ' · 仅本体'}`;
}

function renderSummary(result) {
  const panel = $('#summaryPanel');
  panel.hidden = false;
  const summary = result.summary;
  const cards = [
    ['采集材料种类', `${summary.rawKinds} 种`],
    ['需要收集总数', `${summary.rawTotal} 个`],
    ['合成步骤', `${summary.craftSteps} 步`],
    ['涉及机器', `${summary.machines} 种`],
  ];
  $('#summaryGrid').innerHTML = cards
    .map(([label, value]) => `<div class="card"><span class="card-value">${value}</span><span class="card-label">${label}</span></div>`)
    .join('');

  const warnings = [];
  if (result.cycles.length > 0) {
    warnings.push(`⚠ 检出 <b>${result.cycles.length}</b> 个循环依赖（配方互为原料），已按"需人工确认"处理：${result.cycles.slice(0, 5).map((cycle) => escapeHtml(cycle.name)).join('、')}`);
  }
  if (result.missing.length > 0) {
    warnings.push(`⚠ <b>${result.missing.length}</b> 个物品没有配方数据，已当作生料列出：${result.missing.slice(0, 8).map((item) => escapeHtml(item.name)).join('、')}`);
  }
  if (result.leftover.length > 0) {
    warnings.push(`ℹ 取整后富余：${result.leftover.slice(0, 8).map((item) => `${escapeHtml(item.name)}×${item.count}`).join('、')}`);
  }
  if (result.inventoryUsed && Object.keys(result.inventoryUsed).length > 0) {
    warnings.push(`ℹ 已按库存抵扣：${result.usedInventory.map((item) => `${escapeHtml(item.name)} -${item.used}`).join('、')}`);
  }
  if (result.unknownInventory && result.unknownInventory.length > 0) {
    warnings.push(`⚠ 库存里有没匹配上的写法，已忽略：${result.unknownInventory.map(escapeHtml).join('、')}`);
  }
  $('#warnList').innerHTML = warnings.map((text) => `<div class="warn">${text}</div>`).join('');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function renderTree(result) {
  const container = $('#treeView');
  const nodes = result.tree.roots.map((root) => treeNodeHtml(root, true));
  container.innerHTML = nodes.join('') || '<p class="empty">还没有结果。</p>';
}

function treeNodeHtml(node, isRoot) {
  const hasChildren = node.children.length > 0;
  const craftBits = [];
  if (hasChildren) {
    craftBits.push(`<span class="chip machine">${escapeHtml(node.machine)}</span>`);
    craftBits.push(`<span class="chip">${node.crafts} 次 → ${node.produced} 个</span>`);
  } else {
    const kindLabel = {
      base: '基础材料',
      gather: '采集/掉落',
      cutoff: '中间产物 · 可自制',
      cycle: '循环·需确认',
      unknown: '无配方数据',
      crafted: '成品',
      stock: '库存',
    }[node.leafKind] || '材料';
    craftBits.push(`<span class="chip leaf ${node.leafKind}">${kindLabel}</span>`);
    if (node.shortfall > 0) craftBits.push(`<span class="chip need">去弄 ${node.shortfall}</span>`);
    if (node.fromInventory > 0) craftBits.push(`<span class="chip stock">库存 ${node.fromInventory}</span>`);
  }
  if (node.shared) {
    craftBits.push(`<span class="chip shared" title="被多个分支共用：${escapeHtml((node.sharedFrom || []).join('、'))}">共用</span>`);
  }
  if (node.researchCost) craftBits.push(`<span class="chip research">解锁 ${node.researchCost}</span>`);

  const children = hasChildren
    ? `<div class="children">${node.children.map((child) => treeNodeHtml(child, false)).join('')}</div>`
    : '';
  const toggle = hasChildren ? '<span class="toggle">▾</span>' : '<span class="toggle empty"></span>';

  return `<div class="node ${isRoot ? 'root' : ''} ${node.leaf ? 'leaf-node' : ''}">
    <div class="node-head" data-item-id="${escapeHtml(node.id)}" title="点击查看配方">
      ${toggle}
      ${iconHtml(node.id, 20)}
      <span class="node-name">${escapeHtml(node.name)}</span>
      <span class="node-qty">×${node.quantity}</span>
      ${craftBits.join('')}
    </div>
    ${children}
  </div>`;
}

function renderMaterials(result) {
  const rows = result.raw.map((item) => {
    const kindLabel = {
      base: '<span class="tag base">基础材料</span>',
      gather: '<span class="tag gather">采集/掉落</span>',
      cutoff: '<span class="tag cutoff">中间产物 · 可自制</span>',
      cycle: '<span class="tag cycle">循环·需确认</span>',
      unknown: '<span class="tag unknown">无配方数据</span>',
      target: '<span class="tag">目标</span>',
    }[item.kind] || '<span class="tag">材料</span>';
    return `<tr data-item-id="${escapeHtml(item.id)}" title="点击查看配方">
      <td class="num">${item.count}</td>
      <td><span class="cell-item">${iconHtml(item.id, 20)}${escapeHtml(item.name)}</span></td>
      <td class="muted">${item.demand}</td>
      <td class="muted">${item.fromInventory || 0}</td>
      <td>${kindLabel}</td>
      <td class="muted small">${escapeHtml(item.id)}</td>
    </tr>`;
  }).join('');
  $('#materialsView').innerHTML = rows
    ? `<table><thead><tr><th>要弄到</th><th>材料</th><th>总需求</th><th>库存抵扣</th><th>类型</th><th>ID</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="empty">不需要额外采集任何材料（库存已满足）。</p>';
}

function renderOrder(result) {
  const rows = result.workOrder.map((step) => {
    const materials = step.materials
      .map((material) => `${escapeHtml(material.name)} ×${material.total}`)
      .join('　+　');
    return `<tr>
      <td class="num">${step.step}</td>
      <td>${escapeHtml(step.name)}</td>
      <td class="num">${step.crafts}</td>
      <td class="num">${step.produced}</td>
      <td><span class="chip machine">${escapeHtml(step.machine)}</span></td>
      <td class="materials-cell">${materials || '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
  $('#orderView').innerHTML = rows
    ? `<table><thead><tr><th>#</th><th>要合成的物品</th><th>次数</th><th>产出</th><th>机器</th><th>每次投料（已按次数折算）</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="empty">没有需要合成的步骤。</p>';
}

function renderRoutes(result) {
  const reports = result.variantReport || [];
  if (reports.length === 0) {
    $('#routesView').innerHTML = '<p class="empty">这次的目标没有遇到"多条合成途径"的物品。</p>';
    return;
  }
  $('#routesView').innerHTML = reports.map((report) => {
    const options = report.candidates.map((candidate) => {
      const checked = candidate.machine === report.picked ? 'checked' : '';
      return `<label class="route-option">
        <input type="radio" name="route-${escapeHtml(report.id)}" value="${escapeHtml(candidate.key)}" ${checked}>
        <span class="route-machine">${escapeHtml(candidate.machine)}</span>
        <span class="muted">每次产出 ${candidate.output} · 单位成本 ${candidate.unitCost.toFixed(2)}</span>
        <span class="route-materials">${candidate.materials.map(escapeHtml).join(' + ')}</span>
      </label>`;
    }).join('');
    return `<div class="route-card" data-id="${escapeHtml(report.id)}">
      <div class="route-head"><b>${escapeHtml(report.name)}</b><span class="muted">当前选择：${escapeHtml(report.picked)}</span></div>
      ${options}
    </div>`;
  }).join('');

  $('#routesView').querySelectorAll('input[type=radio]').forEach((input) => {
    input.addEventListener('change', () => {
      const card = input.closest('.route-card');
      const id = card.dataset.id;
      if (input.checked) {
        state.recipeChoice[id] = input.value;
        state.autoSelect = false;
        $('#autoSelect').checked = false;
        saveSettings();
        runPlan();
      }
    });
  });
}

function renderBaseGroups() {
  $('#baseGroups').innerHTML = BASE_MATERIAL_GROUPS.map((group) => {
    const items = group.items.map((id) => {
      const checked = state.baseMaterials.has(id) ? 'checked' : '';
      return `<label class="base-item"><input type="checkbox" data-base-id="${escapeHtml(id)}" ${checked}> ${escapeHtml(state.dataset.name(id))}</label>`;
    }).join('');
    return `<details class="base-group" open>
      <summary>${escapeHtml(group.label)} <span class="muted">(${group.items.length})</span></summary>
      <div class="base-items">${items}</div>
    </details>`;
  }).join('');

  $('#baseGroups').querySelectorAll('input[data-base-id]').forEach((input) => {
    input.addEventListener('change', () => {
      const id = input.dataset.baseId;
      if (input.checked) state.baseMaterials.add(id);
      else state.baseMaterials.delete(id);
      saveSettings();
      runPlan();
    });
  });
}

function renderSources(addonCount) {
  const hostNote = isStaticHost()
    ? '当前是<b>静态托管</b>（GitHub Pages）：补录只保存在你的浏览器里。'
    : '当前是<b>本地模式</b>：补录可以写回 <code>data/overrides.json</code>。';
  $('#sourceInfo').innerHTML = `核心配方：<code>data/recipes.core.jsonl</code>（549 条，Slimefun4 本体）<br>
    已启用附属：${addonCount ? escapeHtml(state.addonFiles.join('、')) : '无'}<br>
    公共补录：<code>${BUILTIN_OVERRIDES_FILE}</code> · 本地补录：<b>${state.localOverrides.length}</b> 条<br>
    ${hostNote}`;
}

// ---------------------------------------------------------------- 交互

function setBadge(id, value) {
  const badge = $(id);
  badge.textContent = value;
  badge.classList.toggle('zero', !value);
}

function runPlan() {
  if (state.targetList.length === 0) {
    $('#resultPanel').hidden = true;
    $('#summaryPanel').hidden = true;
    state.result = null;
    return;
  }

  const result = compute();
  state.result = result;
  $('#resultPanel').hidden = false;

  // 采集清单里当前选中的物品如果还在，刷新它的详情（数量可能变了）
  if (state.recipeFocus) describeAndRender(state.recipeFocus);

  renderSummary(result);
  renderTree(result);
  renderMaterials(result);
  renderOrder(result);
  renderRoutes(result);
  setBadge('#materialBadge', result.raw.length);
  setBadge('#orderBadge', result.workOrder.length);
  setBadge('#routeBadge', (result.variantReport || []).length);
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((other) => other.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((pane) => pane.classList.remove('active'));
      tab.classList.add('active');
      const pane = document.querySelector(`.tab-pane[data-pane="${tab.dataset.tab}"]`);
      if (pane) pane.classList.add('active');
    });
  });
}

function setupTreeControls() {
  $('#treeView').addEventListener('click', (event) => {
    const toggle = event.target.closest('.toggle');
    const head = event.target.closest('.node-head');
    if (!head) return;
    const node = head.parentElement;
    // 点前面的小三角 = 折叠/展开；点其它地方 = 看这个物品的配方
    if (toggle || !head.dataset.itemId) {
      if (node.querySelector('.children')) node.classList.toggle('collapsed');
      return;
    }
    openRecipe(head.dataset.itemId);
  });
  $('#expandAll').addEventListener('click', () => {
    document.querySelectorAll('#treeView .node').forEach((node) => node.classList.remove('collapsed'));
  });
  $('#collapseAll').addEventListener('click', () => {
    document.querySelectorAll('#treeView .node').forEach((node) => {
      if (node.querySelector('.children')) node.classList.add('collapsed');
    });
  });
  $('#exportText').addEventListener('click', () => {
    if (!state.result) return;
    const lines = [];
    const walk = (node, prefix, isLast, isRoot) => {
      const head = isRoot ? '' : (isLast ? '└─ ' : '├─ ');
      const extra = node.children.length > 0 ? `（${node.machine} ×${node.crafts} → ${node.produced}）` : `  ← 去弄 ${node.shortfall || node.quantity}`;
      lines.push(`${prefix}${head}${node.name} ×${node.quantity}${extra}`);
      const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
      node.children.forEach((child, index) => walk(child, childPrefix, index === node.children.length - 1, false));
    };
    state.result.tree.roots.forEach((root) => walk(root, '', true, true));
    downloadText('配方树.txt', lines.join('\n'));
  });
}

function downloadText(filename, text) {
  const blob = new Blob([`\ufeff${text}`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function setupMaterialsControls() {
  $('#exportMaterials').addEventListener('click', () => {
    if (!state.result) return;
    const lines = ['要弄到,材料,总需求,库存抵扣,类型,ID'];
    for (const item of state.result.raw) {
      lines.push([item.count, item.name, item.demand, item.fromInventory || 0, item.kind, item.id].join(','));
    }
    downloadText('采集清单.csv', lines.join('\n'));
  });
  $('#copyMaterials').addEventListener('click', async () => {
    if (!state.result) return;
    const text = state.result.raw.map((item) => `${item.name} ×${item.count}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      $('#copyMaterials').textContent = '已复制 ✓';
      setTimeout(() => { $('#copyMaterials').textContent = '复制文本'; }, 1500);
    } catch (err) {
      console.warn(err);
    }
  });
}

// ---------------------------------------------------------------- 物品选框

function suggestItemHtml(hit) {
  return `<div class="suggest-item" data-id="${escapeHtml(hit.id)}">
    ${iconHtml(hit.id, 20)}
    <span class="suggest-name">${escapeHtml(hit.name)}</span>
    <span class="tag-id">${escapeHtml(hit.id)}${hit.recipeType ? ` · ${escapeHtml(hit.recipeType)}` : ''}</span>
  </div>`;
}

/** 物品搜索框：只负责"选中一个物品"，不做自由文本解析，避免抓错物品 */
function setupItemPicker() {
  const input = $('#itemInput');
  const box = $('#suggestBox');

  const render = () => {
    const query = input.value.trim();
    const hits = query ? state.dataset.search(query, 14) : [];
    if (hits.length === 0) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = hits.map(suggestItemHtml).join('');
  };

  const choose = (id) => {
    addTarget(id, readQuantity());
    input.value = '';
    box.hidden = true;
    $('#qtyInput').value = '1';
  };

  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const query = input.value.trim();
      if (!query) return;
      // 优先精确命中；否则取搜索首项（仍是"选择"而不是猜测）
      const exact = state.dataset.has(query) ? query : resolveItemId(query);
      if (exact) choose(exact);
      else {
        showNotice(`没找到「${query}」，换一个名字或从列表里点选。`);
      }
    }
  });
  box.addEventListener('click', (event) => {
    const item = event.target.closest('.suggest-item');
    if (!item || !item.dataset.id) return;
    choose(item.dataset.id);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.search-wrap')) box.hidden = true;
  });

  $('#addTargetBtn').addEventListener('click', () => {
    const query = input.value.trim();
    if (!query) {
      showNotice('先在上面选中一个物品，再点「添加」。');
      return;
    }
    const id = state.dataset.has(query) ? query : resolveItemId(query);
    if (!id) {
      showNotice(`没找到「${query}」，换一个名字或从下拉列表里点选。`);
      return;
    }
    choose(id);
  });

  $('#qtyInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('#addTargetBtn').click();
    }
  });
}

function readQuantity() {
  const value = Math.floor(Number($('#qtyInput').value) || 0);
  return value > 0 ? value : 1;
}

function addTarget(id, count) {
  if (!state.dataset.has(id)) return;
  const existing = state.targetList.find((item) => item.id === id);
  if (existing) existing.count += count;
  else state.targetList.push({ id, count: Math.max(1, count) });
  saveSettings();
  renderTargetList();
  hideNotice();
  runPlan();
}

function removeTarget(id) {
  state.targetList = state.targetList.filter((item) => item.id !== id);
  saveSettings();
  renderTargetList();
  runPlan();
}

function setTargetCount(id, count) {
  const target = state.targetList.find((item) => item.id === id);
  if (!target) return;
  target.count = Math.max(1, Math.floor(count) || 1);
  saveSettings();
  runPlan();
}

function renderTargetList() {
  const container = $('#targetList');
  if (state.targetList.length === 0) {
    container.innerHTML = '<div class="target-empty">还没有添加目标。上面挑一个物品、填好数量，点「添加」。</div>';
    return;
  }
  container.innerHTML = state.targetList.map((item) => `
    <div class="target-row" data-id="${escapeHtml(item.id)}">
      <span class="t-name">${escapeHtml(state.dataset.name(item.id))}</span>
      <span class="t-id">${escapeHtml(item.id)}</span>
      <input type="number" min="1" step="1" value="${item.count}" data-role="count" aria-label="数量">
      <button class="t-remove" data-role="remove" title="移除">✕</button>
    </div>`).join('');

  container.querySelectorAll('.target-row').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-role=count]').addEventListener('change', (event) => {
      setTargetCount(id, Number(event.target.value));
    });
    row.querySelector('[data-role=remove]').addEventListener('click', () => removeTarget(id));
  });
}

function showNotice(html) {
  const notice = $('#inputNotice');
  notice.hidden = false;
  notice.innerHTML = html;
}

function hideNotice() {
  const notice = $('#inputNotice');
  notice.hidden = true;
  notice.innerHTML = '';
}

// ---------------------------------------------------------------- 快捷标签

const QUICK_PRESETS = [
  { name: '人造钻石', count: 1 },
  { name: '碳块', count: 8 },
  { name: '钢锭', count: 64 },
  { name: '铁粉', count: 64 },
  { name: '强化合金锭', count: 16 },
];

function setupQuickChips() {
  $('#quickChips').innerHTML = QUICK_PRESETS
    .map((preset) => `<button class="chip-btn" data-name="${escapeHtml(preset.name)}" data-count="${preset.count}">${escapeHtml(preset.name)} ×${preset.count}</button>`)
    .join('');
  $('#quickChips').addEventListener('click', (event) => {
    const button = event.target.closest('.chip-btn');
    if (!button) return;
    const id = resolveItemId(button.dataset.name);
    if (!id) {
      showNotice(`数据集里没有「${button.dataset.name}」，可能你的服务器版本或附属不同。`);
      return;
    }
    addTarget(id, Number(button.dataset.count) || 1);
  });
}

/** 批量文本：解析成清单后仍然走同一套"清单 → 计划"流程 */
function setupBatchInput() {
  $('#parseBatchBtn').addEventListener('click', () => {
    const { targets, unknown } = parseTargets($('#targetInput').value);
    if (targets.length > 0) {
      for (const target of targets) addTarget(target.id, target.count);
      $('#targetInput').value = '';
    }
    if (unknown.length > 0) {
      showNotice(`这些名字没匹配上，已跳过：<b>${escapeHtml(unknown.join('、'))}</b>　（请用选框挑选，或改用物品 ID）`);
    } else if (targets.length === 0) {
      showNotice('没解析出任何物品，检查一下格式：<code>物品名 x 数量</code>。');
    }
  });
}

function setupSettings() {
  const inventory = $('#inventoryInput');
  inventory.value = state.inventoryText;
  inventory.addEventListener('change', () => {
    state.inventoryText = inventory.value;
    saveSettings();
    const { unknown } = parseInventory(state.inventoryText);
    if (unknown.length > 0) {
      showNotice(`库存里有这几行没匹配上物品，已忽略：<b>${escapeHtml(unknown.join('、'))}</b>　（格式：<code>物品名 = 数量</code>）`);
    } else {
      hideNotice();
    }
    if (state.targetList.length > 0) runPlan();
  });

  const overrideInput = $('#overrideInput');
  overrideInput.value = JSON.stringify(state.localOverrides, null, 2);

  /** 保存后立刻重建数据集并重算 */
  const applyOverrides = async (list, message) => {
    state.localOverrides = list;
    writeLocalOverrides(list);
    state.overrides = mergeOverrides(await readBuiltinOverrides(), list);
    state.dataset = createDatasetWithOverrides(state.overrides);
    state.usageIndex = buildUsageIndex(state.dataset);
    renderTargetList();
    if (message) alert(message);
    if (state.recipeFocus) describeAndRender(state.recipeFocus);
    if (state.targetList.length > 0) runPlan();
  };

  $('#saveOverrides').addEventListener('click', async () => {
    let parsed;
    try {
      parsed = JSON.parse((overrideInput.value || '[]').replace(/^\uFEFF/, ''));
      if (!Array.isArray(parsed)) throw new Error('必须是 JSON 数组');
    } catch (err) {
      alert(`补录格式有误：${err.message}`);
      return;
    }
    await applyOverrides(parsed, '已保存到你自己的浏览器（不会影响别人），配方已重新载入。');
  });

  $('#exportOverrides').addEventListener('click', () => {
    downloadText('slimefun-overrides.json', JSON.stringify(state.localOverrides, null, 2));
  });

  $('#importOverrides').addEventListener('click', () => $('#importOverrideFile').click());
  $('#importOverrideFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) throw new Error('文件里必须是 JSON 数组');
      overrideInput.value = JSON.stringify(parsed, null, 2);
      await applyOverrides(parsed, `已导入 ${parsed.length} 条补录。`);
    } catch (err) {
      alert(`导入失败：${err.message}`);
    } finally {
      event.target.value = '';
    }
  });

  $('#reloadOverrides').addEventListener('click', async () => {
    overrideInput.value = JSON.stringify(state.localOverrides, null, 2);
    alert('已重新载入当前浏览器里的补录。');
  });
}

// ---------------------------------------------------------------- 采集清单粒度

const DEPTH_HINTS = {
  1: '清单停在直接投料的中间产物（铜粉、铁粉、压缩碳…），你可以自己做也可以去买/换。',
  2: '再往下展开一层，介于"直接投料"和"全部生料"之间。',
  3: '展开三层，适合想看更细的来源但还不想追到矿石。',
  all: '一路展开到原版生料（煤炭、沙砾、铁矿石…），适合从头收集。',
};

function renderDepthHint() {
  $('#depthHint').textContent = DEPTH_HINTS[state.materialDepth] || '';
}

function setupDepth() {
  const select = $('#depthSelect');
  select.value = state.materialDepth;
  renderDepthHint();
  select.addEventListener('change', () => {
    state.materialDepth = select.value;
    renderDepthHint();
    saveSettings();
    if (state.targetList.length > 0) runPlan();
  });
}

function installIconFallback() {
  document.addEventListener('error', (event) => {
    const img = event.target;
    if (!img || img.tagName !== 'IMG' || !img.dataset.fallback) return;
    const seen = Number(img.dataset.fallbackTry || 0);
    const chain = img.dataset.fallback.split('|').filter(Boolean);
    if (seen < chain.length) {
      img.dataset.fallbackTry = String(seen + 1);
      img.src = chain[seen];
      return;
    }
    // 全部失败：藏掉图片，露出后面的首字母徽章
    img.classList.add('icon-failed');
  }, true);
}

// ---------------------------------------------------------------- 物品图标

/** 生成一个图标元素：能拿到贴图就显示贴图，否则显示首字母徽章 */
function iconHtml(id, size = 20) {
  const icon = resolveIcon(id, {
    enabled: state.iconsEnabled,
    overrides: state.iconOverrides,
    iconMap: state.iconMap,
    iconCache: state.iconCache,
  });
  const badge = `<span class="icon-badge tone-${icon.tone}">${escapeHtml(icon.fallbackText)}</span>`;
  if (!icon.url) return `<span class="item-icon" style="--icon-size:${size}px">${badge}</span>`;
  const chain = [icon.fallbackUrl].filter(Boolean).join('|');
  return `<span class="item-icon" style="--icon-size:${size}px">${badge}` +
    `<img src="${escapeHtml(icon.url)}" alt="" loading="lazy" data-fallback="${escapeHtml(chain)}">` +
    '</span>';
}

// ---------------------------------------------------------------- 物品详情

function itemLink(id) {
  return `<button class="item-link" data-item="${escapeHtml(id)}">${iconHtml(id, 18)}<span>${escapeHtml(state.dataset.name(id))}</span></button>`;
}

function recipeGridHtml(layout, outputId, outputCount) {
  if (!layout) return '';
  const rows = [];
  for (let row = 0; row < layout.rows; row += 1) {
    const cells = [];
    for (let col = 0; col < layout.cols; col += 1) {
      const slot = layout.grid[row]?.[col] || null;
      if (slot?.material) {
        cells.push(`<div class="slot filled" data-item="${escapeHtml(slot.material)}" title="${escapeHtml(slot.name || slot.material)}">${iconHtml(slot.material, 28)}</div>`);
      } else {
        cells.push('<div class="slot"></div>');
      }
    }
    rows.push(cells.join(''));
  }
  return `<div class="recipe-flow">
    <div class="grid-wrap">
      <div class="recipe-grid" style="grid-template-columns:repeat(${layout.cols},1fr)">${rows.join('')}</div>
      <div class="grid-caption">${layout.isMachineList ? '投料（机器按份数投喂）' : '摆位（按 3×3 网格对齐）'}</div>
    </div>
    <div class="arrow">→</div>
    <div class="grid-wrap">
      <div class="recipe-grid output-grid">
        <div class="slot filled output" data-item="${escapeHtml(outputId)}" title="${escapeHtml(state.dataset.name(outputId))}">
          ${iconHtml(outputId, 28)}
          ${outputCount > 1 ? `<span class="slot-count">×${outputCount}</span>` : ''}
        </div>
      </div>
      <div class="grid-caption">产出 ${outputCount} 个</div>
    </div>
  </div>`;
}

function describeAndRender(id) {
  if (!state.dataset || !state.dataset.name) return;
  state.recipeFocus = id;
  const host = $('#recipeHost');
  if (!host) return;

  const info = describeItem(state.dataset, id, state.usageIndex);
  const parts = [];

  parts.push(`<div class="detail-head">
    ${iconHtml(id, 40)}
    <div>
      <h3>${escapeHtml(info.name)}</h3>
      <div class="muted small">${escapeHtml(id)}</div>
    </div>
    <div class="detail-actions">
      <button class="item-link" data-add-target="${escapeHtml(id)}">加入目标</button>
      ${info.hasRecipe ? `<button class="item-link" data-add-base="${escapeHtml(id)}">加入基础材料名单</button>` : ''}
    </div>
  </div>`);

  if (!info.hasRecipe) {
    parts.push(`<p class="hint">数据里没有这个物品的配方条目，所以它会被当作"要去弄到的东西"（基础材料 / 采集物）<b>此处不会往下展开</b>。</p>`);
  } else if (info.kind === 'gather') {
    parts.push(`<p class="hint">获取方式：<b>${escapeHtml(info.recipeType)}</b>（不是合成配方，直接算作采集/掉落）。</p>`);
  } else {
    parts.push(`<div class="detail-meta">
      <span class="chip machine">${escapeHtml(info.recipeType)}</span>
      <span class="chip">一次产出 ${info.output} 个</span>
      ${info.researchCost ? `<span class="chip research">解锁等级 ${info.researchCost}</span>` : ''}
      ${info.research ? `<span class="chip">研究：${escapeHtml(info.research)}</span>` : ''}
    </div>`);
    parts.push(recipeGridHtml(info.layout, id, info.output));

    parts.push('<h4>需要</h4><div class="detail-materials">' + info.layout.materials
      .map((material) => `<div class="detail-material">${itemLink(material.material)}<span class="muted">×${material.slotCount}</span></div>`)
      .join('') + '</div>');

    if (info.variants.length > 1) {
      parts.push(`<h4>其它路线</h4><div class="detail-materials">${info.variants.slice(1).map((variant) =>
        `<div class="detail-material"><span class="chip machine">${escapeHtml(variant.recipeType)}</span><span class="muted">产出 ${variant.output}</span></div>`).join('')}</div>`);
    } else {
      parts.push('<p class="hint">数据里这个物品只记录了一条配方；游戏里若有其它途径（洗矿、打粉等），可以在「设置 → 手工补录配方」用 <code>appendVariant</code> 补成额外路线。</p>');
    }
  }

  parts.push('<h4>用途</h4>');
  if (info.usedBy.length === 0) {
    parts.push('<p class="hint">没有配方用到它（可能是最终成品，或服务端魔改后不再需要）。</p>');
  } else {
    parts.push(`<div class="detail-materials">${info.usedBy.slice(0, 60).map((used) =>
      `<div class="detail-material">${itemLink(used.id)}</div>`).join('')}</div>`);
    if (info.usedBy.length > 60) parts.push(`<p class="hint">还有 ${info.usedBy.length - 60} 项未显示。</p>`);
  }

  host.innerHTML = parts.join('');
  host.querySelectorAll('[data-item]').forEach((element) => {
    element.addEventListener('click', () => openRecipe(element.dataset.item));
  });
  host.querySelectorAll('[data-add-target]').forEach((element) => {
    element.addEventListener('click', () => addTarget(element.dataset.addTarget, 1));
  });
  host.querySelectorAll('[data-add-base]').forEach((element) => {
    element.addEventListener('click', () => {
      state.baseMaterials.add(element.dataset.addBase);
      saveSettings();
      renderBaseGroups();
      if (state.targetList.length > 0) runPlan();
    });
  });
}

/** 打开配方详情：自动切到"配方查看"页签 */
function openRecipe(id) {
  if (!state.dataset?.has(id)) return;
  describeAndRender(id);
  const tab = document.querySelector('.tab[data-tab="recipe"]');
  if (tab) tab.click();
  const host = $('#recipeHost');
  if (host) host.scrollIntoView({ block: 'nearest' });
}

/** 支持 #recipe=物品ID 直接打开某个物品的配方（方便分享链接） */
function recipeFromHash() {
  try {
    const hash = decodeURIComponent(location.hash || '');
    const match = hash.match(/recipe=(.+)$/);
    return match ? match[1] : null;
  } catch (err) {
    return null;
  }
}

function setupRecipeView() {
  installIconFallback();

  const input = $('#recipeSearch');
  const box = $('#recipeSuggest');
  const render = () => {
    const query = input.value.trim();
    if (!query) {
      box.hidden = true;
      return;
    }
    const hits = state.dataset.search(query, 14);
    box.hidden = false;
    box.innerHTML = hits.length
      ? hits.map((hit) => `<div class="suggest-item" data-id="${escapeHtml(hit.id)}">${iconHtml(hit.id, 20)}<span>${escapeHtml(hit.name)}</span><span class="tag-id">${escapeHtml(hit.id)}</span></div>`).join('')
      : '<div class="suggest-item muted">没有匹配的物品</div>';
  };
  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  box.addEventListener('click', (event) => {
    const item = event.target.closest('.suggest-item');
    if (!item?.dataset.id) return;
    input.value = '';
    box.hidden = true;
    describeAndRender(item.dataset.id);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.recipe-search')) box.hidden = true;
  });

  // 树状图 / 采集清单 里点击任意物品 → 打开配方
  $('#treeView').addEventListener('click', (event) => {
    const node = event.target.closest('[data-item-id]');
    if (!node) return;
    openRecipe(node.dataset.itemId);
  });
  $('#materialsView').addEventListener('click', (event) => {
    const row = event.target.closest('[data-item-id]');
    if (!row) return;
    openRecipe(row.dataset.itemId);
  });

  if (state.dataset.has('simefun4:SYNTHETIC_DIAMOND')) describeAndRender('simefun4:SYNTHETIC_DIAMOND');
}

// ---------------------------------------------------------------- 启动

async function main() {
  loadSettings();
  const urlTheme = themeFromUrl();
  if (urlTheme) state.theme = urlTheme;
  applyTheme();
  $('#autoSelect').checked = state.autoSelect;

  let addonCount = 0;
  try {
    addonCount = (await loadData()).length;
  } catch (err) {
    $('#datasetInfo').innerHTML = `⚠ 数据加载失败：${escapeHtml(err.message)}<br>请用「启动配方助手.cmd」打开，或确认 data/recipes.core.jsonl 存在。`;
    return;
  }

  // 第一次打开时给一个能直接看到效果的清单
  if (state.targetList.length === 0) {
    const seed = resolveItemId('人造钻石');
    if (seed) state.targetList = [{ id: seed, count: 1 }];
  }

  await readIconConfig();
  $('#iconsToggle').checked = state.iconsEnabled;

  renderDatasetInfo(addonCount);
  renderBaseGroups();
  renderSources(addonCount);
  renderTargetList();
  setupTheme();
  setupTabs();
  setupTreeControls();
  setupMaterialsControls();
  setupItemPicker();
  setupBatchInput();
  setupDepth();
  setupSettings();
  setupQuickChips();
  runPlan();
  setupRecipeView();

  // 深链接：#recipe=物品ID → 直接打开该物品的配方
  const wanted = recipeFromHash();
  if (wanted && state.dataset.has(wanted)){
    describeAndRender(wanted);
    const tab = document.querySelector('.tab[data-tab="recipe"]');
    if (tab) tab.click();
  }

  $('#planBtn').addEventListener('click', () => {
    state.recipeChoice = {};
    runPlan();
  });
  $('#clearBtn').addEventListener('click', () => {
    state.targetList = [];
    saveSettings();
    renderTargetList();
    hideNotice();
    if (state.result) {
      state.result = null;
      runPlan();
    }
  });
  $('#autoSelect').addEventListener('change', () => {
    state.autoSelect = $('#autoSelect').checked;
    if (state.autoSelect) state.recipeChoice = {};
    saveSettings();
    if (state.targetList.length > 0) runPlan();
  });
  $('#iconsToggle').addEventListener('change', () => {
    state.iconsEnabled = $('#iconsToggle').checked;
    saveSettings();
    runPlan();
    if (state.recipeFocus) describeAndRender(state.recipeFocus);
  });
}

main();
