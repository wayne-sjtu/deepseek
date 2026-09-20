# 数据可获取性说明（接口对照 + 获取方式）

> 这份文档回答一个问题：**看板上的每个数字，现在能不能通过企业接口真实拿到、怎么拿。**
> 所有结论都来自对 `document.yaml` 的逐条核对，不是推测。核对日期与文档版本见 §7。

---

## 0. 结论速览

| 结论 | 说明 |
|---|---|
| **可以拿到** | 看板上**全部**指标都有对应的真实接口字段，不存在「编出来但接口没有」的数 |
| **不需要改造聚合层** | 企业的 `openapi/usage/members/detail` **原生支持 `departmentIds` 过滤并返回部门信息**，部门级消耗可直接按部门查询 |
| **需要两次接口调用做关联** | 「代码行数 / AI 占比」与「Credits 消耗」**分属两个不同接口**，且**没有共同的主键之外的交集**，必须按 `userId` 关联 |
| **存在真实缺口** | 5 项（见 §4），其中 3 项是接口能力边界，2 项是需求本身超出接口范围（Git 提交行数、需求吞吐） |
| **本文档同时纠正了一处早期判断** | 之前认为「部门维度只能由调用方 rollup」，这个结论**不完整**：消耗维度可直接按部门查，只有**研发效能维度**（代码量/采纳率）才需要 rollup |

---

## 1. 数据流：看板数字来自哪三个接口

```
                        ┌─────────────────────────────────────────────┐
                        │ ① 成员名册（部门归属的唯一事实来源）          │
                        │    GET /openapi/members                     │
                        │    → userId, userName, departmentIds,       │
                        │      departmentName, email, joinedAt        │
                        └───────────────┬─────────────────────────────┘
                                        │  userId ↔ departmentId 映射（低频，可缓存）
                ┌───────────────────────┴───────────────────────┐
                ▼                                               ▼
┌───────────────────────────────┐             ┌───────────────────────────────┐
│ ② 研发效能（代码量与采纳）      │  userId     │ ③ 用量与成本（Credits）        │
│  POST /dashboard/member/data  │ ◄─────────► │  POST /openapi/usage/         │
│  → 新增代码行 / AI 生成行 /     │   关联      │       members/detail          │
│    AI 占比 / 采纳率 / 对话次数  │             │  → creditConsumed / model /   │
│  ⚠ 无部门入参，按成员返回       │             │    departmentId（★可直接按部门查）│
└───────────────────────────────┘             └───────────────────────────────┘
                │                                               │
                └───────────────┬───────────────────────────────┘
                                ▼
                 ┌──────────────────────────────────┐
                 │ 本方案后端：按 userId / departmentId │
                 │ 关联 + rollup（口径唯一实现）        │
                 └──────────────────────────────────┘
```

**关键点**：② 与 ③ **都不提供「代码行数 + 消耗」的联合视图**。这是必须做关联的根本原因。

---

## 2. 完整接口清单（本方案涉及的全部接口）

### 2.1 成员与组织

| # | 方法 | 路径 | 用途 | 关键出参 | 部门能力 |
|---|---|---|---|---|---|
| 1 | GET | `/openapi/members` | **成员名册（主）** | `userId, userName, email, departmentIds[], departmentName, joinedAt, enabled` | 出参含部门；入参仅 `keyword`，**无部门过滤** |
| 2 | GET | `/users` | 成员列表（旧） | `uid, nickname, enterpriseUserName, pluginEnabled, joinEnterpriseAt, email, roles[]` | **入参有 `dep` + `include_subtree` + `is_root`**，但**出参不含部门名**（是 uid，非 UUID） |
| 3 | GET | `/info` | 企业信息 | 企业基础信息 | — |
| 4 | GET | `/license` | License 席位 | 席位信息 | — |

> ⚠️ **UUID vs uid**：接口 2 返回的 `uid` 与接口 1/3 的 `userId`（UUID）**不是同一体系**。
> 用量类接口要求 UUID，因此**不要用接口 2 的结果去查用量**，否则会落入 `invalidUserIds`。
> 接口 2 的价值仅在于「按部门筛成员 uid」，实际用途有限。

### 2.2 研发效能（代码贡献）—— 看板核心数据源

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/dashboard/member/data` | **成员级代码量与 AI 占比（逐人明细）** |
| POST | `/dashboard/analytics/activity` | 活跃状态分析（活跃用户数/率/分布） |
| POST | `/dashboard/analytics/dialog` | 对话分析（次数/用户数/能力与模型分布） |
| POST | `/dashboard/analytics/completion` | 补全分析（生成/采纳次数、采纳率、语言分布） |
| POST | `/dashboard/analytics/generation` | 代码生成分析（生成量、增长量、生成率） |
| GET | `/metrics` | 旧看板指标时序（18 个白名单指标） |

`/dashboard/member/data` 出参字段（**逐人，可直接支撑「个人效能」页全部列**）：

```
memberId, memberName, userNickname, lastActiveTime,
departmentIds[], departmentNames[], departmentFullPaths[],
primaryDepartmentId, primaryDepartmentName,
dialogCount, dialogAskCount, dialogCraftCount, dialogCustomCount,
dialogCommandCount, dialogContextCount, dialogAgentCount,
dialogKnowledgeCount, dialogActionCount,
completionGenerateCount, completionAcceptCount, completionAcceptRateByCount,
completionGenerateLines,    completionAcceptLines,    completionAcceptRateByLines,
completionGenerateChars,    completionAcceptChars,    completionAcceptRateByChars,
aiGenerateCodeLines, totalNewCodeLines, codeGenerateRateByLines,
aiGenerateCodeChars, totalNewCodeChars, codeGenerateRateByChars
```

**入参**（`timeRange` / `memberFilter` / `clientFilter` / `pluginFilter` / `pagination` / `memberOptions`）
—— **没有 `departmentIds`**。这是 §4 缺口 G1 的来源。

### 2.3 用量与成本 —— 部门级消耗的原生入口

| 方法 | 路径 | 用途 | 部门能力 |
|---|---|---|---|
| POST | `/openapi/usage/members/detail` | **用量明细（按事件逐条）** | ★ **入参 `departmentIds[]`、`userIds[]`、`eventTypes[]`、`groupId`；出参含 `departmentId` + `departmentInfo`（含 `fullPath`）** |
| POST | `/openapi/usage/members/query` | 批量查成员额度 + 用量 | 入参只有 `userIds` / `userNames` |
| POST | `/openapi/usage/members/limit-query` | 批量查成员限量配置 | 同上 |
| POST | `/openapi/usage/members/quota/update` | 调整成员额度 | 同上 |
| POST | `/openapi/usage/departments/{departmentId}/quota/update` | **调整部门下全部成员额度** | ★ 按部门写 |
| GET | `/openapi/usage/quota-cycle` | 额度周期 | 企业级 |
| GET | `/openapi/usage/default-quota` | 默认成员额度 | 企业级 |
| GET | `/openapi/resources/overview` | 积分与席位余额 | 企业级 |

`/openapi/usage/members/detail` 出参字段（**逐事件，部门级消耗的推荐数据源**）：

```
recordId, requestId, eventType, eventId, messageId, triggerId,
userId, userName, departmentId, departmentInfo{ departmentId, departmentName,
displayName, fullPath, parentId },
modelName, client, principalType, clientId, usageTime,
creditConsumed, packageId, consumptionType, projectId, sessionId
```

**分页与时间限制（必须按此设计）**：

| 模式 | 参数 | 限制 |
|---|---|---|
| 兼容模式（默认 `version=0/1`） | `pageNum` / `pageSize`（≤1000） | `totalCount` 为真实总数 |
| 游标模式（`version=2`） | `pageToken` / `nextPageToken` | **可拉全量**；`startTime` 不早于 90 天前；单次跨度 ≤ 31 天；`totalCount` 仅当页条数；不支持 `principalTypes` |

> **实践建议**：部门级消耗用 `version=2` + `departmentIds` 按 31 天分段拉取，
> 逐事件求和；或对每个部门单独查询（部门数通常 <20，代价可接受）。

### 2.4 可观测（token / 时延 / 错误率 / 会话）

| 方法 | 路径 | 用途 | 部门能力 |
|---|---|---|---|
| POST | `/openapi/observability/metric-summary/query` | 指标窗口汇总 + 环比 | 入参仅 `userId` / `sessionId` 精确匹配，**无部门** |
| POST | `/openapi/observability/metric-trend/query` | 指标时序（支持 `groupBy`） | `groupBy` **不支持 `department`**；`filters` 白名单含 `user.id` |
| POST | `/openapi/observability/metric-records/query` | 聚合记录 / TopN 分组 | 同上 |
| POST | `/openapi/observability/traces/query` | 对话 Trace 列表 | 文档明示：**应用身份无部门数据范围语义，部门类筛选参数不开放** |
| POST | `/openapi/observability/sessions/query` | 会话列表 | 同上 |

指标名白名单（26 个）：`genai_request_count`、`model_request_count`、`model_error_count`、
`tool_call_count`、`tool_error_count`、`tool_error_rate`、`session_count`、`user_count`、`dau`、
`credit`、`credit_cost`、`input_token`、`output_token`、`token_usage`、`cache_read_input_token`、
`ttft_avg/p50/p90/p95/p99`、`genai_operation_duration_avg`、
`model_invocation_duration_p50/p90/p99`、`genai_request_error_rate`、token 直方图 10 桶。

> **私有化部署不支持本域**（未配 APM 时返回 404，属预期降级）。

### 2.5 日志（对话内容）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/openapi/session-logs/query` | 对话日志列表：`conversationRequestId, traceId, inputTrunc, modelName, clientType, userName, userId, startTime` |
| GET | `/openapi/session-logs/{conversationRequestId}` | 单条详情（含 2048 字符内的完整输入） |
| GET/POST | `/openapi/session-logs/settings[/update]` | 采集开关与保留天数（≤7 天） |

> ⚠️ **含用户输入内容，属敏感数据**。本看板**不需要**该域；若引入必须单独授权 + 审计。

### 2.6 模型 / 技能 / 专家 / 用户组（本看板未用）

`/openapi/models*`、`/openapi/skills*`、`/openapi/experts*`、`/openapi/groups*` —— 与效能分析无关，
列出仅为完整性。**唯一例外**：`/openapi/groups/{groupId}` 可用于「按用户组代替部门做分组」，
但用户组是人工维护的集合，**不能替代组织架构**。

---

## 3. 指标 → 接口 获取矩阵

图例：**●** 接口直接返回 ｜ **◐** 需一次调用或简单求和 ｜ **○** 需按 userId 关联/聚合 ｜ **✗** 无接口

### 3.1 用量与成本

| 看板指标 | 接口 | 取法 | 复杂度 |
|---|---|---|---|
| 部门 Credits 消耗 | `/usage/members/detail` | `departmentIds=[X]`，求和 `creditConsumed` | ● |
| 部门人均消耗 | 同上 + `/openapi/members` | 部门消耗 ÷ 部门人数 | ◐ |
| 个人 Credits 消耗 | `/usage/members/query` | `userIds=[...]` → `totalUsed` | ● |
| 企业总量 | `/usage/members/detail` 或 `/resources/overview` | 求和 / 直接读 | ● |
| 消耗环比 | 同上 | 两个等长区间各查一次 | ◐ |
| 千行成本 | ② + ③ | Credits ÷ (代码行/1000)，**跨接口按 userId 关联** | ○ |
| 额度使用率 | `/usage/members/query` | `totalUsed ÷ cycleLimit`（`cycleLimit=null` → 不限量） | ● |
| 额度周期 | `/usage/quota-cycle` | 直接读 `cycleMode/cycleStart/cycleEnd` | ● |
| 积分/席位余额 | `/resources/overview` | 直接读 `remaining/remainingRatio` | ● |
| Token 消耗（企业级） | `/observability/metric-summary` | `metrics:["token_usage"]` | ● |
| Token 消耗（个人级） | 同上 | 传 `userId`，逐人查询 | ○ |
| Token 消耗（部门级） | — | ⚠️ 无部门入参，见缺口 G2 | ✗ |

### 3.2 代码贡献

| 看板指标 | 接口 | 取法 | 复杂度 |
|---|---|---|---|
| 个人新增代码行 | `/dashboard/member/data` | 直接读 `totalNewCodeLines` | ● |
| 个人 AI 生成行 | 同上 | `aiGenerateCodeLines` | ● |
| 个人 AI 代码占比 | 同上 | `codeGenerateRateByLines` | ● |
| 个人补全采纳率 | 同上 | `completionAcceptRateByLines` | ● |
| 个人对话次数 | 同上 | `dialogCount` | ● |
| 个人最近活跃 | 同上 | `lastActiveTime` | ● |
| 部门新增代码行 | 同上 | 遍历成员（`pageSize`≤200）按 `primaryDepartmentId` 求和 | ○ |
| 部门 AI 生成行 / 占比 | 同上 | 同上；**占比先求和再相除** | ○ |
| 部门采纳率 | 同上 | 同上 | ○ |
| 企业级总量 | 同上 或 `/dashboard/analytics/generation` | 求和 / `summary.metrics` | ● |
| 活跃用户数 / 日均活跃 | `/dashboard/analytics/activity` | `summary.metrics[].current` | ● |
| 补全按语言分布 | `/dashboard/analytics/completion` | `charts[].data.items` | ● |
| 对话按能力/模型分布 | `/dashboard/analytics/dialog` | 同上 | ● |
| 会话数 / 平均轮次 | `/dashboard/analytics/dialog` | `sessionCount` / `avgSessionRounds` | ● |

### 3.3 稳定性与体验

| 看板指标 | 接口 | 取法 | 复杂度 |
|---|---|---|---|
| 企业请求失败率 | `/observability/metric-summary` | `genai_request_error_rate` | ● |
| 企业首 Token 时延 | 同上 | `ttft_avg/p95/p99` | ● |
| 企业工具调用失败率 | 同上 | `tool_error_rate` | ● |
| 按模型/客户端分布 | `/observability/metric-trend` 或 `-records` | `groupBy=model/client` | ● |
| **部门稳定性指标** | — | ⚠️ `groupBy` 不支持 department，见缺口 G2 | ✗ |

### 3.4 成员与组织

| 看板维度 | 接口 | 取法 |
|---|---|---|
| 成员名册 + 部门 | `/openapi/members` | 直接读；**部门归属的唯一可靠来源** |
| 部门树（id → 名称/路径） | `/openapi/members` 的 `departmentName` 去重推导 | 文档**没有独立的部门列表接口** |
| 部门人数 | 同上 | 按 `departmentIds` 计数 |

---

## 4. 真实缺口（必须向业务方说明）

### G1｜`/dashboard/member/data` 无法按部门过滤 —— 效能口径的部门聚合靠 rollup

- **证据**：该接口入参只有 `timeRange / memberFilter / clientFilter / pluginFilter / pagination / memberOptions`，**没有 `departmentIds`**。
- **影响**：要把成员级效能数据按部门汇总，必须遍历成员。
- **代价**：`pageSize` 上限 200；1 万成员 = 50 次请求，且每次都要重新遍历时间段。
- **本方案对策**：
  1. 用 `memberFilter: {type:"selected", data:[本部门 userIds]}` 收窄范围（userIds 来自 `/openapi/members` 的部门映射，低频缓存）；
  2. 部门级效能只做**当前窗口**聚合，历史趋势用日粒度快照表落库，避免每次重算。

### G2｜可观测域无法按部门聚合 —— token/时延/错误率的部门视图缺失

- **证据**：`metric-trend` 的 `groupBy` 白名单**不含 `department`**；`traces/query` 文档明示「应用身份无部门数据范围语义，部门类筛选参数不开放」。
- **影响**：**部门级 Token、时延、失败率目前拿不到**。看板若要在部门页展示稳定性，只能：
  - 方案 A：按部门成员列表**逐人查 `userId`** 再求和 —— 部门 × 成员数 次调用，成本高；
  - 方案 B：**不在部门页展示稳定性指标**，只在企业级展示（本方案当前采用）。
- **建议**：向接口方提需求「`groupBy` 支持 `department`」；在此之前不要承诺部门级稳定性看板。

### G3｜无独立部门列表接口

- **证据**：全文只有 `/users` 的 `dep` 入参与 `/usage/departments/{id}/quota/update` 的路径参数涉及部门，**没有 `GET /departments`**。
- **对策**：从 `/openapi/members` 的 `departmentIds` + `departmentName` 去重推导部门树（本方案 mock 服务已提供 `/openapi/departments`，真实接入时改为推导或由 IdP 提供）。
- **风险**：空部门（无成员的部门）不会出现；部门层级需靠 `fullPath` 解析。

### G4｜成员 ID 体系不统一（UUID vs uid）

- **证据**：`/openapi/members` 返回 `userId`（UUID），`/users` 返回 `uid`；用量类接口要求 UUID。
- **对策**：统一以 `/openapi/members` 的 `userId` 作为主键；`/users` 仅用于「按部门筛 uid」这类无替代的场景，且**必须做映射后再调用量接口**。

### G5｜需求本身超出接口范围（需求侧，不是接口缺陷）

| 需求原话 | 现状 | 说明 |
|---|---|---|
| 「每个人的**提交**代码行数」 | 接口提供的是**新增代码总行数**（`totalNewCodeLines`），统计的是编辑器内 AI 采纳 + 生成插入的行 | **不等于 Git commit 的 diff 行数**。要 Git 口径需接入 GitLab/GitHub 事件，属新增数据源 |
| 「AI 提交的**占比**」 | 接口提供的是**AI 生成行 ÷ 新增代码总行数** | 分母是「新增代码」而非「提交代码」，两者口径不同，需在页面上明示 |
| 「效能数据」的提效幅度 | 接口只有行数/采纳/消耗 | 证明提效需**需求吞吐、缺陷率、交付周期**，均无接口 |

---

## 5. 接入真实接口的实现路径（替换点在 `DataSource`）

当前 `backend/app/server.py` 的 `DataSource` 从 mock JSON 读取。接真实接口时**只改这一个类**：

```
DataSource.reload()
  ├── ① GET  /openapi/members                    → members[]（分页遍历，带部门）
  ├── ② POST /dashboard/member/data              → 逐人代码量（按 userIds 收窄）
  ├── ③ POST /openapi/usage/members/detail       → 逐事件 Credits（version=2 游标 + departmentIds）
  ├── ④ POST /openapi/usage/members/query        → 逐人 totalUsed / cycleLimit
  ├── ⑤ GET  /openapi/usage/quota-cycle          → 额度周期
  ├── ⑥ GET  /openapi/resources/overview         → 积分与席位
  ├── ⑦ POST /observability/metric-summary       → 稳定性指标（企业级）
  └── ⑧ 按 userId / departmentId 关联 ②③④，复用 metrics.py 的聚合
```

`metrics.py` 的聚合逻辑**不需要改**——它只依赖「成员 × 日」或「成员 × 事件」的字段形状。

### 必须实现的工程约束

| 约束 | 要求 |
|---|---|
| 认证 | 必须用 **admin 开发平台的企业级应用（应用身份）**；个人 API Key 调用任意接口返回 401 |
| Token 存放 | 只在服务端，不下发浏览器 |
| 分页 | `member/data` 用 `pageSize=200`；`usage/members/detail` 用 `version=2` 游标 |
| 时间分段 | `usage/members/detail` 单次跨度 ≤31 天，`startTime` 不早于 90 天前 → 长区间必须分段 |
| 限流 | 逐人循环调用必须带退避与并发上限；建议本地缓存「userId→部门」映射 |
| 降级 | 可观测域 404（私有化/未配 APM）→ 返回「指标不可用」，**不得降级为 0** |
| 时区 | 全部接口时间为东八区 RFC3339；`cycleStart` 含、`cycleEnd` 不含 |

---

## 6. 与当前 Mock 实现的差异对照

Mock 数据是按**真实接口的字段口径**构造的，因此替换数据源时页面零改动。差异仅两处：

| 项 | Mock 实现 | 真实接口 |
|---|---|---|
| 部门列表 | 提供 `GET /api/enterprises/{eid}/openapi/departments`（文档无此接口） | 需从 `/openapi/members` 推导，或由 IdP 提供 |
| 部门维度聚合 | 服务端一次聚合完成 | 消耗维度可直接按 `departmentIds` 查；**效能维度需遍历成员 rollup**（G1） |
| 稳定性指标的部门视图 | mock 中提供了部门级 `requestErrorRate`/`toolErrorRate` | ⚠️ **真实环境拿不到**（G2），接入后该列应改为企业级或隐藏 |

> 第 3 行是**接入时必须处理的差异**：mock 里「部门页的请求失败率」列在真实环境无法填充。

---

## 7. 本文档的核对基准

| 项 | 值 |
|---|---|
| 文档 | `document.yaml`（企业 OpenAPI，7037 行，12 大域，84 个接口） |
| 校验方式 | 逐路径提取 `parameters` / `requestBody.properties` / `responses.*.data.properties`，与看板指标逐项比对 |
| 可复核命令 | 见 `.agents/skills/verify-dashboard-data/SKILL.md`；接口清单见 `docs/API.md`（本文件同目录） |
| 未覆盖 | 模型/技能/专家/用户组四个域与效能分析无关，未逐字段核对（已列于 §2.6） |

**当 `document.yaml` 更新后**，本文档需要重新核对的最小集是：§2.2 与 §2.3 两个数据源的入参
（部门过滤能力是否有变）、§2.4 的 `groupBy` 白名单（是否新增 `department`）、以及 §4 的五个缺口。
