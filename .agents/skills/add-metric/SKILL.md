---
name: add-metric
description: Use when adding, renaming, or changing a metric on the AI efficiency dashboard — e.g. "加一个 X 指标"、"把采纳率换成按字符口径"、"这个数要按部门拆"、"新增一个 KPI 卡/表格列". Covers the full path from aggregation caliber to API field, frontend type, page display, the /metrics caliber registry, and the self-test that must stay green.
whenToUse: 任何会让看板上多出/改动一个数字的需求，都应该先走这个 skill，而不是直接改页面。
---

# 端到端新增一个指标

看板类项目的失败模式几乎都是同一个：**同一个数在不同页面对不上**。所以新增指标不是
「加一列」，而是让口径在六个位置保持一致。按顺序做完，缺一步都会在评审时被打回。

## 六步流水线

```
① 口径定义  →  ② 聚合实现  →  ③ 接口字段  →  ④ 前端类型  →  ⑤ 页面展示  →  ⑥ 口径页登记
   metrics.py     metrics.py     server.py      types.ts      pages/*.tsx    MetricsPage.tsx
                                 + SELFTEST_CASES
```

### ① 口径定义（先写清楚，再写代码）

在动手前必须能回答四个问题，答不上来就是需求还没想清楚：

| 问题 | 说明 |
|---|---|
| 类型 | **求和型**（绝对量，如行数）还是**比率型**（先求和再相除）？ |
| 公式 | 分子、分母分别是什么？分母为 0 时返回什么（`null` 还是 `0`）？ |
| 粒度 | 成员日粒度能否算出？部门/公司级是否可由成员求和得到？ |
| 来源 | 来自 `document.yaml` 哪个接口的哪个字段？还是本方案派生？ |

**比率型指标的铁律**：分子分母各自求和后再相除。绝不能对个人比率取平均。

判断派生字段是否需要新增：先查 `references/data-dictionary.md` 的字段映射表，
很多时候 `SUM_FIELDS` 里已经有该原始字段，只是没有对外暴露别名。

### ② 聚合实现（`backend/app/metrics.py`）

三种情况，改法不同：

**A. 只是暴露已有的求和字段** —— 在 `_finalize()` 里加别名最省事：

```python
out["newMetric"] = totals["xx"]          # totals 中的键需在 SUM_FIELDS 中
out["newMetricRate"] = _ratio(totals["a"], totals["b"])   # 比率型，分母为 0 自动返回 None
```

**B. 需要一个全新的日粒度原始字段** —— 要同时改两处：

1. `SUM_FIELDS` 加字段名（否则聚合时不会被累加）；
2. `gen_mock.py` 的 `series.append({...})` 里产出该字段，并在
   `agg.setdefault(...)` / 求和循环的字段元组里登记（**否则成员维度聚合会漏掉它**）。

**C. 需要跨维度聚合（如按模型、按客户端）** —— 参考 `server.py` 中
`analytics_dialog` 的 `model_map`、`member_detail` 的 `model_mix` 写法，
按「日期 → 记录」遍历后自行分桶。

### ③ 接口字段（`backend/app/server.py`）

- 扩展接口（`/api/v1/efficiency/*`）：在对应构造函数里加入字段。响应里与
  `document.yaml` 同名的字段直接写原名；本方案扩展字段用 `__` 前缀（如 `__quotaUsageRate`）。
- 若要新增**独立端点**：在 `route()` / `route_enterprise()` 中登记，并同步：
  - 文件顶部的接口清单注释；
  - `SELFTEST_CASES`（含错误分支，如非法参数应返回 400）。
- 错误语义：参数非法返回 `err(40001, ...)`；**不要**把查询失败降级为 0。

### ④ 前端类型（`frontend/src/lib/types.ts`）

在对应接口的响应类型上加字段。可选字段用 `?`，可能为空的比率用 `number | null`
（后端分母为 0 时返回 `null`，前端必须处理 `—`）。

### ⑤ 页面展示（`frontend/src/pages/`）

- 数字格式化一律用 `lib/format.ts`（`fmtCredit` / `fmtPercent` / `fmtCompact` / `fmtInt`），
  不要在 JSX 里写 `toFixed`。
- **比率型指标必须携带 `deltaUnit: 'point'`**（KPI 卡）或按百分点说明，否则
  「81.2% - 80.4%」会被显示成误导性的 `+0.8%`。
- 消耗类指标（Credits / Token）设 `higherIsBetter: false`，上涨显示红色。
- 表格里数值列右对齐并带 `ProgressBar`（若 0~100 语义）。
- **消耗与产出成对**：如果新指标是比率（如 AI 代码占比），同一视图里必须能同时看到
  Credits 消耗与绝对产出。做不到就不要单独加这个占比。

### ⑥ 口径页登记（`frontend/src/pages/MetricsPage.tsx`）

往 `METRICS` 数组加一条：`group / name / field / formula / source / caliber / caveat`。
**这一步不是可选项**：看板的可信度来自「每个数字都能查到定义」，漏登记会让整页失效。

## 验证（必须全绿才算完成）

```bash
python3 backend/app/server.py --selftest          # 接口 + 汇总一致性
cd frontend && npm run typecheck && npm run build
npm run verify -- http://127.0.0.1:8000           # 渲染自检（截图人工复核）
```

手工再核对一次：

```bash
# 比率型指标：确认「先求和再相除」与逐人平均确实不同（若相同说明实现写错了）
curl -s "http://127.0.0.1:8000/api/v1/efficiency/overview?startTime=2026-08-22&endTime=2026-09-20" \
  | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(d['org'])"
```

## 反模式（评审会直接打回）

| 反模式 | 为什么错 |
|---|---|
| 前端页面里自己算部门汇总 | 口径出现第二份实现，必然漂移 |
| 对个人比率求平均得部门比率 | 辛普森悖论 |
| 把新字段只加在 `server.py` 输出里 | 聚合层没有它，值恒为 0 或缺失 |
| 分母为 0 时返回 0 | 与「真实为 0」无法区分，应返回 `null` 并用 `—` 展示 |
| 忘记 `SUM_FIELDS` / 忘记 `gen_mock` 求和元组 | 成员维度静默丢字段，只有部门级看起来是对的 |
| 只改页面不改口径页 | 数字对不上时无人能判断谁对 |
