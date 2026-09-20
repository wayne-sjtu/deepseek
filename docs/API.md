# 后端接口契约（Mock 阶段）

服务入口：`backend/app/server.py`（Python 标准库，零第三方依赖）

```bash
python3 backend/app/gen_mock.py                 # 1. 生成 mock 数据集（生成物不入库，必须先跑）
python3 backend/app/server.py --selftest        # 2. 接口 + 口径一致性自检
python3 backend/app/server.py --port 8000       # 3. 启动服务（同时托管 frontend/dist）
```

- 默认地址：`http://127.0.0.1:8000`
- 前端开发态：`cd frontend && npm run dev` → `http://127.0.0.1:5173`（已配置 `/api` 代理）
- 生产态：`npm run build` 后由本服务同源托管，无 CORS 问题

---

## 0. 通用约定

**统一响应包装**（与企业 OpenAPI 一致）

```json
{ "code": 0, "msg": "OK", "requestId": "3f2b...", "data": { } }
```

| code | HTTP | 含义 |
|---|---|---|
| 0 | 200 | 成功 |
| 40001 | 400 | 参数非法（指标名不在白名单、limitType 非法、区间缺失…） |
| 40301 | 403 | 企业不存在 / 跨企业访问被拒绝 |
| 40400 | 404 | 未实现的接口或分析类型 |
| 50000 | 500 | 服务端异常 |

> 原则：**查询失败绝不降级为 0**。把「查询失败」渲染成「额度用尽」会触发误报警，比失败本身更糟。

**时间格式**

- 本方案扩展接口：`startTime` / `endTime` 使用 `YYYY-MM-DD`（闭区间，含首含尾）
- 对齐企业接口的部分：ISO 8601 带时区（东八区），或 Unix 秒（可观测域）

**字段命名**

- 与 `document.yaml` 同名的字段 = 直接来自企业接口
- `__` 前缀字段 = 本方案为效能分析扩展的派生字段（后端 rollup 产出）

---

## 1. 本方案扩展接口（前端主用）

### 1.1 效能总览

`GET /api/v1/efficiency/overview`

| 参数 | 必填 | 说明 |
|---|---|---|
| startTime / endTime | 否 | `YYYY-MM-DD`，默认取数据集最后一天往前 30 天 |
| departmentIds | 否 | 逗号分隔的部门 ID，多选 |
| userIds | 否 | 逗号分隔的成员 ID，多选 |

响应 `data`：

```jsonc
{
  "range": { "start": "2026-08-22", "end": "2026-09-20",
             "previousStart": "2026-07-23", "previousEnd": "2026-08-21", "days": 30 },
  "org": {
    "credit": 78586.9,                    // Credits 消耗
    "dialogCount": 17802,
    "sessionCount": 6104,
    "requestCount": 18120,
    "tokenUsage": 56714315,
    "inputTokens": 41230000,
    "outputTokens": 15484315,
    "cacheReadInputTokens": 15200000,
    "toolCallCount": 9021,
    "aiCodeLines": 76544,                 // AI 生成代码行
    "totalNewCodeLines": 94250,           // 新增代码总行数
    "codeGenerateRateByLines": 81.18,     // AI 代码占比 %
    "codeGenerateRateByChars": 79.4,
    "completionAcceptRateByLines": 34.44, // 补全采纳率 %
    "completionAcceptRateByCount": 29.1,
    "completionAcceptLines": 29100,
    "activeUserNum": 45,
    "dau": 41.2,
    "requestErrorRate": 0.11,
    "toolErrorRate": 0.51,
    "avgCreditsPerActiveUser": 1746.38,
    "avgAiLinesPerActiveUser": 1701.0,
    "memberCount": 48,
    "seatTotal": 72, "seatUsed": 48,
    "resourceItems": [ { "resourceType": "credit", "total": 0, "used": 0, "remaining": 0, "remainingRatio": 0.42 } ],
    "quotaCycle": { "cycleMode": "natural_month", "cycleStart": "...", "cycleEnd": "...", "nextCycleStart": "..." },
    "previous": { "credit": 77117.66, "dialogCount": 0, "aiCodeLines": 0,
                  "totalNewCodeLines": 0, "codeGenerateRateByLines": 80.36,
                  "activeUserNum": 47, "tokenUsage": 0 }
  },
  "departments": [
    {
      "departmentId": "dept-001", "departmentName": "平台研发中心", "fullPath": "示例科技集团/平台研发中心",
      "memberCount": 12, "activeUserNum": 12, "activeRate": 100.0,
      "credit": 25215.19, "previousCredit": 23617.23, "creditGrowthRate": 6.77, "creditShare": 32.09,
      "avgCreditPerUser": 2101.27, "dialogCount": 5601, "sessionCount": 1902, "requestCount": 5702,
      "tokenUsage": 18000000, "aiCodeLines": 29932, "totalNewCodeLines": 33293,
      "aiCodeRate": 89.9, "acceptRateByLines": 40.3, "creditsPerKline": 757.37,
      "aiLinesPerActiveUser": 2494.0, "requestErrorRate": 0.06, "toolErrorRate": 0.4
    }
  ],
  "trend": [
    { "date": "2026-08-22", "credit": 1420.5, "totalNewCodeLines": 3210,
      "aiCodeLines": 2600, "aiCodeRate": 80.9, "activeUserNum": 43 }
  ]
}
```

### 1.2 成员效能明细

`GET /api/v1/efficiency/members`

| 参数 | 必填 | 说明 |
|---|---|---|
| startTime / endTime | 否 | 同上 |
| departmentIds / userIds | 否 | 同上 |
| page / pageSize | 否 | 默认 1 / 20，上限 200 |
| sortBy | 否 | `totalNewCodeLines`（默认）、`aiGenerateCodeLines`、`codeGenerateRateByLines`、`completionAcceptRateByLines`、`totalUsed`、`__creditsPerKline`、`dialogCount`、`activeDays`、`memberName`… |
| sortOrder | 否 | `desc`（默认） / `asc` |
| keyword | 否 | 匹配成员名 / 昵称 / 部门名 |

响应 `data`：`{ members: MemberRow[], pagination: { page, pageSize, total, totalPage }, range, orgSummary }`

`MemberRow` 字段与 `document.yaml` L1785–L1923 对齐，另外包含扩展字段：

```jsonc
{
  "memberId": "...", "memberName": "孙若冰", "primaryDepartmentName": "平台研发中心",
  "lastActiveTime": "2026-09-20T17:42:00+08:00", "activeDays": 28,
  "totalNewCodeLines": 3844, "aiGenerateCodeLines": 3703, "codeGenerateRateByLines": 96.33,
  "completionGenerateCount": 2100, "completionAcceptCount": 700,
  "completionGenerateLines": 4200, "completionAcceptLines": 1980,
  "completionAcceptRateByLines": 45.0, "completionAcceptRateByCount": 33.3,
  "dialogCount": 628, "totalUsed": 2968.56, "cycleLimit": 3654, "cycleLimitDisplay": "3654",
  "__credit": 2968.56, "__previousCredit": 2402.1, "__creditGrowthRate": 23.58,
  "__sessionCount": 210, "__requestCount": 640,
  "__tokenUsage": 1977792, "__inputTokens": 1496000, "__outputTokens": 481792,
  "__quotaUsageRate": 81.24, "__creditsPerKline": 772.26, "__aiLinesPerActiveDay": 132.3
}
```

> **注意**：额度使用率的分子（窗口消耗）与分母（周期限量）口径不同。额度风险判断请使用
> `usage` 接口并**对齐额度周期**，参见 §2.1 与前端「额度管理」页的周期开关。

### 1.3 成员效能详情

`GET /api/v1/efficiency/member/{memberId}`（`memberId` 支持 UUID 或用户名）

响应 `data`：`{ member, profile, range, trend[], modelMix[], clientMix[], languageMix[] }`

- `trend[]`：逐日的 `credit / aiCodeLines / totalNewCodeLines / aiCodeRate / dialogCount /
  completionAcceptLines / acceptRateByLines / tokenUsage`（缺失日补 0）
- `modelMix[] / clientMix[] / languageMix[]`：`{ label, value(Credits), extra: { dialogCount, aiCodeLines, share } }`

### 1.4 额度风险清单

`GET /api/v1/efficiency/quota`

| 参数 | 必填 | 说明 |
|---|---|---|
| startTime / endTime | 否 | **建议传额度周期区间**（见 §3.3） |
| departmentIds / keyword | 否 | 过滤 |
| page / pageSize | 否 | 默认 1 / 200，上限 500 |

响应 `data.items[]`：

```jsonc
{
  "userId": "...", "userName": "钱星野", "departmentId": "dept-001", "departmentName": "平台研发中心",
  "cycleLimit": 1438, "cycleLimitDisplay": "1438",
  "totalUsed": 1482.92, "__quotaUsageRate": 103.12,
  "riskLevel": "high"        // high(≥90) | medium(70~90) | low(<70) | unlimited
}
```

### 1.5 数据集元信息

`GET /api/v1/efficiency/meta` → `{ meta, quotaCycle, defaultQuota, audit[] }`

`audit[]` 记录本会话内的额度调整（`at / action / departmentId / limitType / newLimit / affectedCount`）。

---

## 2. 对齐企业 OpenAPI 的接口

路径与字段严格对齐 `document.yaml`，用于二期替换数据源时的联调核对。

### 2.1 用量域

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/enterprises/{eid}/openapi/usage/quota-cycle` | `cycleType / cycleMode / cycleStart / cycleEnd / nextCycleStart` |
| GET | `/api/enterprises/{eid}/openapi/usage/default-quota` | 默认成员额度（`cycleLimit = -1` 表示不限量） |
| POST | `/api/enterprises/{eid}/openapi/usage/default-quota/update` | 调整默认额度，返回 `affectedCount` |
| POST | `/api/enterprises/{eid}/openapi/usage/members/query` | `{ userIds?, userNames?, startTime?, endTime?, pageNum?, pageSize? }` → `items[] / totalCount / invalidUserNames[]` |
| POST | `/api/enterprises/{eid}/openapi/usage/members/limit-query` | 只查限量配置（不含用量） |
| POST | `/api/enterprises/{eid}/openapi/usage/members/quota/update` | `{ userIds?, userNames?, limitType, newLimit? }` → `affectedCount` |
| POST | `/api/enterprises/{eid}/openapi/usage/departments/{departmentId}/quota/update` | `{ limitType, newLimit? }` → `affectedCount` |

### 2.2 监控指标域

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/enterprises/{eid}/dashboard/member/data` | 体 `{ timeRange, memberFilter, clientFilter, pluginFilter, pagination, memberOptions }` |
| POST | `/api/enterprises/{eid}/dashboard/analytics/{activity\|dialog\|completion\|generation}` | 统一返回 `DashboardResponse`（`summary.metrics[]` + `charts[]` + `trends.series[]` + `dimension`） |
| GET | `/api/enterprises/{eid}/metrics?queries=...&range.start=...&range.end=...&range.step=...` | 返回 `{ 指标名: [时间戳数组, 值数组] }`，支持 18 个白名单指标 |

### 2.3 可观测域

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/enterprises/{eid}/openapi/observability/metric-summary/query` | `{ range:{start,end}(Unix秒), metrics[] }` → `fields[]（含 momRate / compareValue）` |
| POST | `/api/enterprises/{eid}/openapi/observability/metric-trend/query` | 增加 `groupBy / granularity / filters` → `bucketSeconds + lines[]` |
| POST | `/api/enterprises/{eid}/openapi/observability/metric-records/query` | 明细记录（含 userId / 模型 / 客户端 / 插件 / 语言 + 指标值） |

**指标白名单**：`genai_request_count`、`model_request_count`、`model_error_count`、`tool_call_count`、
`tool_error_count`、`tool_error_rate`、`session_count`、`user_count`、`dau`、`credit`、`credit_cost`、
`input_token`、`output_token`、`token_usage`、`cache_read_input_token`、`ttft_avg/p50/p90/p95/p99`、
`genai_operation_duration_avg`、`model_invocation_duration_p50/p95`、
`completion_accept_rate_by_lines`、`code_generate_rate_by_lines`、`ai_generate_code_lines`、
`total_new_code_lines`、`dialog_count`。非白名单指标返回 `400`。

### 2.4 组织与资源

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/enterprises/{eid}/info` | 企业信息 |
| GET | `/api/enterprises/{eid}/openapi/members?pageNum&pageSize&keyword` | 成员列表（含部门、加入时间） |
| GET | `/api/enterprises/{eid}/openapi/departments` | 部门树（本方案补充，企业接口无独立部门列表端点） |
| GET | `/api/enterprises/{eid}/openapi/resources/overview` | 积分与席位余额（`items[]` + `sources[]`） |
| GET | `/healthz` | 健康检查（含数据集元信息） |

---

## 3. 关键口径与注意事项

### 3.1 部门维度必须由调用方 rollup

企业 OpenAPI 可观测域明确：`groupBy` **不支持 `department`**（依赖组织架构，应用身份无该语义，返回 400）。
而 `dashboard/member/data` 提供的是**成员级**数据（含 `departmentIds` / `primaryDepartmentName`），
因此部门口径只能由调用方聚合 —— 这是本方案后端存在的主要价值。

聚合实现见 `backend/app/metrics.py::aggregate`，并在 `--selftest` 中自动校验
「部门汇总之和 == 成员汇总之和 == 公司总量」。

### 3.2 比率必须「先求和再相除」

AI 代码占比、补全采纳率等比率一律由聚合后的分子/分母相除得到，**不取个人比率的算术平均**。

### 3.3 额度周期与看板窗口可能不对齐

- 周期切分以 `cycleMode` 为准：`default` = 按订阅生效日切片，`natural_month` = 自然月；
  `cycleType`（如 `MONTHLY`）只是档位标签，**不决定周期怎么切分**。
- `cycleStart` 含、`cycleEnd` 不含；时间均为东八区（+08:00）。
- 前端「额度管理」页默认**对齐额度周期**计算使用率，另有开关可切换为跟随看板窗口。

### 3.4 用户标识优先用 UUID

`usage/members/query` 等接口中，`userNames` 遇到特殊符号、空格、中英文混排、全半角差异、Emoji
时可能无法匹配用户，被归入 `invalidUserNames` 而**不报错**。务必优先使用 `userIds`（UUID）。

### 3.5 私有化部署的降级

可观测域在未配置 APM 数据源时返回 404，属预期降级；前端应对「指标不可用」做空态展示，
而不是显示 0。

---

## 4. 自检

```bash
python3 backend/app/server.py --selftest
```

覆盖内容：

| 检查项 | 说明 |
|---|---|
| 21 个接口用例 | 覆盖扩展接口、企业接口、可观测域、错误分支（非法指标名 400、跨企业 403） |
| 汇总一致性 | 部门汇总 credits == 成员汇总 credits == 公司总量（误差 < 0.01） |
| 响应体积 | 打印每个用例的 payload 大小，防止首屏响应失控 |

前端页面自检（需要本机 Chrome）：

```bash
cd frontend && npm run build
node scripts/verify-pages.mjs http://127.0.0.1:8000
```

逐页收集控制台错误、失败请求与关键文案，并输出截图到 `frontend/verification/`。
