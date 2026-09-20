/**
 * 接口与数据来源目录。
 *
 * 这份数据是「看板数字从哪来」的单一事实来源：
 * - 页面用它渲染「数据来源与可获取性」表，避免在 JSX 里散落接口说明；
 * - 详细论证与缺口分析见工作区根目录的 `docs/DATA-MAPPING.md`（本文档只放结论，不放推导过程）。
 *
 * availability 语义：
 * - `direct`    接口直接返回，无需加工
 * - `aggregate` 需要按 userId / departmentId 关联或求和（本方案后端负责）
 * - `missing`   当前接口拿不到（能力边界，需向接口方提需求或调整产品形态）
 */

export type Availability = 'direct' | 'aggregate' | 'missing'

export interface ApiSource {
  scene: string
  method: 'GET' | 'POST'
  path: string
  fields: string
  /** 部门维度能力 —— 这是本项目最容易踩坑的地方 */
  department: string
  availability: Availability
  /** 接入时的硬约束 */
  constraint?: string
}

export const API_SOURCES: ApiSource[] = [
  {
    scene: '成员名册与部门归属',
    method: 'GET',
    path: '/enterprises/{eid}/openapi/members',
    fields: 'userId, userName, email, departmentIds[], departmentName, joinedAt, enabled',
    department: '出参含部门；入参仅 keyword，无部门过滤',
    availability: 'direct',
    constraint: 'userId（UUID）是所有用量类接口的推荐入参；须分页（pageSize ≤ 200）遍历',
  },
  {
    scene: '逐人代码量与 AI 占比',
    method: 'POST',
    path: '/enterprises/{eid}/dashboard/member/data',
    fields:
      'totalNewCodeLines, aiGenerateCodeLines, codeGenerateRateByLines/Chars, completion*（次数/行/字符 + 采纳率）, dialogCount, lastActiveTime, primaryDepartmentId',
    department: '★ 入参无 departmentIds —— 部门口径需 rollup（缺口 G1）',
    availability: 'aggregate',
    constraint: '可用 memberFilter={type:selected, data:[部门成员 userIds]} 收窄范围，减少遍历量',
  },
  {
    scene: '部门级 Credits 消耗',
    method: 'POST',
    path: '/enterprises/{eid}/openapi/usage/members/detail',
    fields: 'userId, userName, departmentId, departmentInfo{fullPath}, modelName, client, eventType, usageTime, creditConsumed',
    department: '★ 入参含 departmentIds[]，出参含部门详情 —— 可直接按部门查',
    availability: 'direct',
    constraint: '长区间必须分段：version=2 时 startTime 不早于 90 天前、单次跨度 ≤ 31 天；用 pageToken 游标翻页',
  },
  {
    scene: '成员额度与用量消耗',
    method: 'POST',
    path: '/enterprises/{eid}/openapi/usage/members/query',
    fields: 'userId, userName, cycleLimit, cycleLimitDisplay, totalUsed, invalidUserIds, invalidUserNames',
    department: '无部门入参',
    availability: 'direct',
    constraint: '优先用 userIds（UUID）；userNames 遇全半角/emoji 会静默落入 invalidUserNames',
  },
  {
    scene: '额度周期与默认额度',
    method: 'GET',
    path: '/openapi/usage/quota-cycle 与 /openapi/usage/default-quota',
    fields: 'cycleType, cycleMode, cycleStart, cycleEnd, nextCycleStart, cycleLimit（-1 表示不限量）',
    department: '企业级',
    availability: 'direct',
    constraint: '周期切分以 cycleMode 为准；cycleStart 含、cycleEnd 不含；时间均为东八区',
  },
  {
    scene: '额度调整（成员 / 部门）',
    method: 'POST',
    path: '/openapi/usage/members/quota/update 与 /openapi/usage/departments/{departmentId}/quota/update',
    fields: 'limitType(limited|unlimited), newLimit, affectedCount',
    department: '★ 部门级调整按 departmentId 写入',
    availability: 'direct',
    constraint: '部门级调整会覆盖该部门下已单独配置额度的成员，属高影响操作',
  },
  {
    scene: '积分与席位余额',
    method: 'GET',
    path: '/enterprises/{eid}/openapi/resources/overview',
    fields: 'items[].resourceType/total/used/remaining/remainingRatio, sources[], upcomingSources[]',
    department: '企业级',
    availability: 'direct',
    constraint: '查询失败返回 5xx 而非降级为 0 —— 不得把「查询失败」渲染成「额度用尽」',
  },
  {
    scene: '活跃 / 对话 / 补全 / 生成分析',
    method: 'POST',
    path: '/enterprises/{eid}/dashboard/analytics/{activity|dialog|completion|generation}',
    fields: 'summary.metrics[]（current/previous/growthRate）, charts[].data.items, trends.series[]',
    department: '无部门入参',
    availability: 'direct',
    constraint: '统一 DashboardResponse 结构，可直接驱动 KPI 卡与图表',
  },
  {
    scene: '稳定性与体验（token / 时延 / 失败率）',
    method: 'POST',
    path: '/openapi/observability/metric-summary/query（另有 trend / records）',
    fields: 'genai_request_count, genai_request_error_rate, token_usage, ttft_avg/p95/p99, tool_error_rate 等 26 个白名单指标',
    department: '✗ groupBy 不支持 department，部门类筛选不开放（缺口 G2）',
    availability: 'missing',
    constraint: '私有化未配 APM 时返回 404 属预期降级；部门视图只能逐人查 userId 后求和，成本高',
  },
  {
    scene: '对话日志（含用户输入）',
    method: 'POST',
    path: '/openapi/session-logs/query 等',
    fields: 'conversationRequestId, modelName, clientType, userName, userId, startTime（详情含 2048 字符内输入）',
    department: '无部门入参',
    availability: 'missing',
    constraint: '含用户输入内容，属敏感数据；本看板不使用，若引入须单独授权与审计',
  },
]

export const AVAILABILITY_META: Record<Availability, { label: string; tone: 'mint' | 'amber' | 'rose' }> = {
  direct: { label: '可直接获取', tone: 'mint' },
  aggregate: { label: '需关联/聚合', tone: 'amber' },
  missing: { label: '当前不可获取', tone: 'rose' },
}

/** 已确认的接口能力缺口（结论行，推导见 DATA-MAPPING.md §4） */
export const DATA_GAPS = [
  {
    id: 'G1',
    title: '逐人效能数据无法按部门过滤',
    detail:
      '/dashboard/member/data 入参没有 departmentIds，部门级代码量与 AI 占比必须遍历成员后 rollup。1 万成员 ≈ 50 次请求（pageSize 上限 200）。',
    action: '用部门成员 userIds 收窄 memberFilter，并对历史窗口落日粒度快照，避免每次重算',
  },
  {
    id: 'G2',
    title: '可观测域无法按部门聚合',
    detail:
      'metric-trend 的 groupBy 白名单不含 department，traces/session 查询明示「应用身份无部门数据范围语义」。部门级 Token / 时延 / 失败率当前拿不到。',
    action: '部门页不展示稳定性指标（已按此实现）；如需，须向接口方提「groupBy 支持 department」',
  },
  {
    id: 'G3',
    title: '没有独立的部门列表接口',
    detail: '全文无 GET /departments，部门树只能从成员列表的 departmentIds + departmentName 去重推导。',
    action: '从成员列表推导并缓存；注意空部门不会出现，层级需解析 fullPath',
  },
  {
    id: 'G4',
    title: '成员 ID 体系不统一（UUID vs uid）',
    detail: '/openapi/members 返回 UUID，旧 /users 返回 uid，而用量类接口要求 UUID。',
    action: '统一以 /openapi/members 的 userId 为主键；旧接口结果须映射后再调用量接口',
  },
  {
    id: 'G5',
    title: '「提交代码行数 / 提效幅度」超出接口范围',
    detail:
      '接口提供的是新增代码总行数（编辑器内采纳 + 生成插入），不等于 Git commit 的 diff；提效还需需求吞吐、缺陷率、交付周期。',
    action: '页面上明示口径差异；Git 口径需接入代码仓库事件，属新增数据源',
  },
]
