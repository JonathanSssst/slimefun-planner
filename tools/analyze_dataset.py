#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数据集体检：统计 recipeType 分布、字段完整性、跨文件 ID 冲突、悬空材料等。

用法:
    python tools/analyze_dataset.py data/recipes.core.jsonl [更多.jsonl ...]
"""
import collections
import json
import os
import sys


def load(path):
    entries = []
    meta = None
    with open(path, encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"  !! {os.path.basename(path)}:{lineno} JSON 解析失败: {exc}")
                continue
            if meta is None and "id" not in obj:
                meta = obj
                continue
            entries.append(obj)
    return meta, entries


def main(paths):
    all_items = []
    by_file = {}
    for path in paths:
        meta, entries = load(path)
        by_file[path] = entries
        all_items.extend(entries)
        label = (meta or {}).get("name", os.path.basename(path))
        print(f"[{os.path.basename(path)}] {label}: {len(entries)} 条")

    print(f"\n合计条目: {len(all_items)}")

    id_counts = collections.Counter(i["id"] for i in all_items)
    dupes = {k: v for k, v in id_counts.items() if v > 1}
    print(f"重复 id: {len(dupes)}")
    for k, v in list(dupes.items())[:20]:
        print(f"  {k} x{v}")

    print("\n=== recipeType 分布 ===")
    for k, v in collections.Counter(i.get("recipeType") for i in all_items).most_common():
        print(f"  {v:5d}  {k}")

    field_counts = collections.Counter()
    for item in all_items:
        field_counts.update(item.keys())
    print("\n=== 字段出现次数 ===")
    for k, v in field_counts.most_common():
        print(f"  {v:5d}  {k}")

    filled = collections.Counter()
    for item in all_items:
        for slot in item.get("recipe") or []:
            if slot and slot.get("material"):
                filled[slot["material"]] += 1
    known = set(id_counts)
    dangling = sorted(m for m in filled if m not in known)
    print(f"\n配方中出现材料 {len(filled)} 种；无自身配方条目(生料/原版) {len(dangling)} 种")
    print("  非 simefun4: 前缀:", sorted(m for m in filled if not m.startswith("simefun4:"))[:60])

    print("\n=== 空配方条目（采集终点候选） ===")
    empty = [i for i in all_items if not [s for s in (i.get("recipe") or []) if s]]
    for i in empty:
        print(f"  {i['id']}  {i.get('name')}  ({i.get('recipeType')})")
    print(f"  共 {len(empty)} 条")

    multi = [i for i in all_items if (i.get("output") or 1) > 1]
    print(f"\n一次产出 >1 的条目: {len(multi)}")

    print("\n=== 同一配方内材料重复（需要按格计数） ===")
    dup_recipe = []
    for i in all_items:
        mats = [s["material"] for s in (i.get("recipe") or []) if s]
        if len(mats) != len(set(mats)):
            dup_recipe.append(i["id"])
    print(f"  共 {len(dup_recipe)} 条（示例如下，最多 15 条）")
    for rid in dup_recipe[:15]:
        print(f"  {rid}")

    no_output = [i["id"] for i in all_items if not i.get("output")]
    print(f"\n缺少 output 字段: {len(no_output)} {no_output[:10]}")


if __name__ == "__main__":
    args = sys.argv[1:] or ["data/recipes.core.jsonl"]
    main(args)
