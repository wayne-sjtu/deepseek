---
name: verify-dashboard-data
description: Use when dashboard numbers must be trusted or are being questioned — "这个数对吗"、"部门加起来对不上"、"环比怎么算的"、"额度为什么显示异常"、"接真实接口前校验一下". Produces a per-number evidence trail and a pass/fail verdict.
whenToUse: 向业务方交付看板前、口径被质疑时、替换数据源后、或任何「数字看起来不对」的排查。
---

# 验证看板数字可信

看板的失败不是崩溃，而是**没人敢信上面的数**。这个 skill 的目标是让每一个数字都能被追溯到
一条查询，并且给出可复核的结论。

## 完成标准

验证结束时，交付物必须包含：

- 每个被质疑的数字对应一条**可复现的 curl + 期望值**；
- 三项硬校验的结论（汇总一致 / 比率口径 / 周期对齐），每项都要有实际输出而非「应该没问题」；
- 页面截图（`frontend/verification/*.png`）作为渲染层证据；
- 明确列出「已验证」「未验证及其原因」。

## 硬校验（三项，逐项跑）

### 一、汇总一致性：部门 == 成员 == 公司

这是本仓库最容易在重构中破掉的不变量（`metrics.py` 的 `aggregate()`）。

```bash
python3 backend/app/server.py --selftest    # 末尾会打印三行 credits 与一致性结论
```

期望：三行数值完全相同（误差 < 0.01）。不一致说明 `_finalize()` 的别名或
`SUM_FIELDS` 求和被改坏了 —— 定位顺序：先看 `SUM_FIELDS` 是否漏字段，再看
`per_member` / `per_dept` 两个桶的累加循环。

### 二、比率口径：先求和再相除

破法通常是有人图省事在前端或后端对个人比率求了平均。

```bash
curl -s "http://127.0.0.1:8000/api/v1/efficiency/overview?startTime=2026-08-22&endTime=2026-09-20" \
| python3 -c "
import json,sys
org=json.load(sys.stdin)['data']['org']
print('聚合口径 AI 占比 =', org['codeGenerateRateByLines'])
print('校验：aiCodeLines/totalNewCodeLines =', round(org['aiCodeLines']/org['totalNewCodeLines']*100,2))
print('校验：acceptLines/genLines =', round(org['completionAcceptLines']/org['completionGenerateLines']*100,2),
      ' vs 字段 =', org['completionAcceptRateByLines'])
"
```

期望：每行的两个数相等。若「字段」与「手工相除」不等，说明比率不是由聚合值算出来的。

再确认它**不等于**个人比率的算术平均（相等往往意味着实现退化成了平均）：

```bash
curl -s "http://127.0.0.1:8000/api/v1/efficiency/members?pageSize=200&startTime=2026-08-22&endTime=2026-09-20" \
| python3 -c "
import json,sys,statistics as st
ms=json.load(sys.stdin)['data']['members']
vals=[m['codeGenerateRateByLines'] for m in ms if m['totalNewCodeLines']]
print('个人比率算术平均 =', round(st.mean(vals),2), '（应小于聚合口径，因为高产出者权重更大）')
"
```

### 三、额度周期对齐

额度使用率 = 消耗 ÷ 周期限量。窗口与周期错配会让 60% 看起来像 90%（或反之）。

```bash
curl -s "http://127.0.0.1:8000/api/enterprises/1234567890/openapi/usage/quota-cycle" \
| python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(d['cycleMode'], d['cycleStart'], '→', d['cycleEnd'])"
```

用返回的 `cycleStart` ~ `cycleEnd - 1天` 去查额度清单，风险分布才有效：

```bash
curl -s "http://127.0.0.1:8000/api/v1/efficiency/quota?startTime=2026-09-01&endTime=2026-09-29&pageSize=500" \
| python3 -c "
import json,sys,collections
items=json.load(sys.stdin)['data']['items']
print(collections.Counter(i['riskLevel'] for i in items))
print('最高使用率样例:', [(i['userName'], i['__quotaUsageRate']) for i in items[:3]])
"
```

前端额度页顶部的「对齐额度周期 / 跟随看板窗口」开关必须与实际请求区间一致 —— 截图核对。

## 逐类数字的追溯方式

| 页面数字 | 追溯查询 | 关键校验 |
|---|---|---|
| 部门 Credits | `/api/v1/efficiency/overview` 的 `departments[].credit` | 与 `org.credit` 求和一致 |
| 个人代码行 / AI 占比 | `/api/v1/efficiency/members` | 与 `/dashboard/member/data` 的 `totalNewCodeLines`、`codeGenerateRateByLines` 同名比对 |
| 额度使用率 | `/api/v1/efficiency/quota` | 区间 == 额度周期；不限量成员应为 `null` 而非 0 |
| 活跃人数 | `overview.org.activeUserNum` | ≤ `memberCount`；与趋势图当日活跃量级不矛盾 |
| 稳定性指标 | `/openapi/observability/metric-summary/query` | 私有化无 APM 时应报不可用，页面显示空态而非 0 |

## 页面层证据

```bash
cd frontend && npm run build
cd .. && python3 backend/app/server.py --port 8000 &
cd frontend && npm run verify -- http://127.0.0.1:8000
```

自检会同时检查：控制台错误、失败请求、关键文案是否渲染（防白屏），并落 6 张截图。
截图必须**人工看一遍**，尤其关注：KPI 的环比单位（比率变化应为 `pp` 而非 `%`）、
消耗类指标上涨是否为红色、空态文案是否说明了原因。

## 常见误判与处置

| 现象 | 真实原因 | 处置 |
|---|---|---|
| 部门之和 ≠ 公司总量 | `SUM_FIELDS` 漏字段或别名没走 `_finalize` | 回 `metrics.py` 补字段，重跑自检 |
| 某成员 AI 占比 100% | `totalNewCodeLines` 极小（新人/试水） | 不是 bug；表格用 `—` 展示零产出，产品上按最小行数过滤 |
| 环比显示 +0.8% 却是比率 | `deltaUnit` 未设 `'point'` | 加 `deltaUnit: 'point'` |
| 额度使用率全员偏低 | 窗口比额度周期短 | 切到「对齐额度周期」 |
| 可观测指标全为 0 | 后端把失败降级成 0 | 违反口径原则 §5，改为显式错误/空态 |
| 活跃人数 45/48 但趋势图很低 | 趋势是按日去重，KPI 是整窗口去重 | 不是 bug；文案需说明「日活跃」与「窗口活跃」区别 |
