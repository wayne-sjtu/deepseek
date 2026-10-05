/**
 * 领域模型。
 *
 * 命名约定：
 * - 与 document.yaml 字段同名的，表示直接来自企业 OpenAPI；
 * - `__` 前缀字段是本方案为效能分析扩展的派生字段（后端 rollup 产出）。
 */

export type Trend = 'increase' | 'decrease' | 'stable' | 'new'

export interface DateRange {
  startTime: string
  endTime: string
}

export interface MetricCard {
  key: string
  name: string
  unit: string
  current: number
  previous: number
  growthRate: number
  changeType: Trend
  higherIsBetter: boolean
}

// ---------------------------------------------------------------------------
// 部门级效能（/api/v1/efficiency/overview）
// ---------------------------------------------------------------------------
export interface DepartmentRow {
  departmentId: string
  departmentName: string
  fullPath: string
  memberCount: number
  activeUserNum: number
  activeRate: number
  credit: number
  previousCredit: number
  creditGrowthRate: number
  creditShare: number
  avgCreditPerUser: number
  dialogCount: number
  sessionCount: number
  requestCount: number
  tokenUsage: number
  aiCodeLines: number
  totalNewCodeLines: number
  aiCodeRate: number
  acceptRateByLines: number
  creditsPerKline: number | null
  aiLinesPerActiveUser: number
  /**
   * 稳定性指标：仅在**企业级**可获取。
   * 企业可观测域的 groupBy 不支持 department（应用身份无组织语义），
   * 因此部门级失败率/时延在真实环境取不到 —— 页面不使用这两个字段。
   * 详见工作区根目录 docs/DATA-MAPPING.md 的缺口 G2。
   */
  requestErrorRate: number | null
  toolErrorRate: number | null
}

export interface ResourceItem {
  resourceType: 'credit' | 'license'
  unit: string
  total: number
  used: number
  remaining: number
  remainingRatio: number
}

export interface QuotaCycle {
  cycleType: string
  cycleMode: string
  cycleStart: string
  cycleEnd: string
  nextCycleStart: string
}

export interface TrendPoint {
  date: string
  credit: number
  totalNewCodeLines: number
  aiCodeLines: number
  aiCodeRate: number
  activeUserNum: number
}

export interface OrgSummary {
  credit: number
  dialogCount: number
  sessionCount: number
  requestCount: number
  tokenUsage: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  toolCallCount: number
  aiCodeLines: number
  totalNewCodeLines: number
  codeGenerateRateByLines: number | null
  codeGenerateRateByChars: number | null
  completionAcceptRateByLines: number | null
  completionAcceptRateByCount: number | null
  completionGenerateCount: number
  completionAcceptCount: number
  completionAcceptLines: number
  activeUserNum: number
  dau: number
  requestErrorRate: number | null
  toolErrorRate: number | null
  avgCreditsPerActiveUser: number
  avgAiLinesPerActiveUser: number
  memberCount: number
  seatTotal: number
  seatUsed: number
  resourceItems: ResourceItem[]
  quotaCycle: QuotaCycle
  previous: Partial<Record<
    | 'credit' | 'dialogCount' | 'aiCodeLines' | 'totalNewCodeLines'
    | 'codeGenerateRateByLines' | 'activeUserNum' | 'tokenUsage',
    number | null
  >>
}

export interface OverviewResponse {
  range: { start: string; end: string; previousStart: string; previousEnd: string; days: number }
  org: OrgSummary
  departments: DepartmentRow[]
  trend: TrendPoint[]
}

// ---------------------------------------------------------------------------
// 个人效能（/dashboard/member/data）
// ---------------------------------------------------------------------------
export interface MemberRow {
  memberId: string
  memberName: string
  userNickname: string | null
  lastActiveTime: string | null
  departmentIds: string[]
  departmentNames: string[]
  departmentFullPaths: string[]
  primaryDepartmentId: string
  primaryDepartmentName: string
  activeDays: number
  dialogCount: number
  completionGenerateCount: number
  completionAcceptCount: number
  completionAcceptRateByCount: number
  completionGenerateLines: number
  completionAcceptLines: number
  completionAcceptRateByLines: number
  completionGenerateChars: number
  completionAcceptChars: number
  completionAcceptRateByChars: number
  aiGenerateCodeLines: number
  totalNewCodeLines: number
  codeGenerateRateByLines: number
  aiGenerateCodeChars: number
  totalNewCodeChars: number
  codeGenerateRateByChars: number
  totalUsed: number
  cycleLimit: number | null
  cycleLimitDisplay: string
  __credit: number
  __previousCredit: number
  __creditGrowthRate: number
  __previousTotalNewCodeLines: number
  __sessionCount: number
  __requestCount: number
  __tokenUsage: number
  __inputTokens: number
  __outputTokens: number
  __quotaUsageRate: number | null
  __creditsPerKline: number | null
  __aiLinesPerActiveDay: number
}

export interface MemberDataResponse {
  members: MemberRow[]
  pagination: { page: number; pageSize: number; total: number; totalPage: number }
  range: { start: string; end: string }
  orgSummary: {
    credit: number
    previousCredit: number
    aiCodeLines: number
    totalNewCodeLines: number
    codeGenerateRateByLines: number
    activeUserNum: number
  }
}

export interface MemberDetailResponse {
  member: MemberRow
  profile: {
    email: string | null
    joinedAt: string
    departmentFullPaths: string[]
    cycleLimit: number | null
    cycleLimitDisplay: string
    primaryLanguage: string
  }
  range: { start: string; end: string; previousStart: string; previousEnd: string }
  trend: Array<{
    date: string
    credit: number
    aiCodeLines: number
    totalNewCodeLines: number
    aiCodeRate: number
    dialogCount: number
    completionAcceptLines: number
    acceptRateByLines: number
    tokenUsage: number
  }>
  modelMix: MixItem[]
  clientMix: MixItem[]
  languageMix: MixItem[]
}

export interface MixItem {
  label: string
  value: number
  extra?: { dialogCount?: number; aiCodeLines?: number; share?: number }
}

// ---------------------------------------------------------------------------
// Dashboard 分析域（/dashboard/analytics/*）
// ---------------------------------------------------------------------------
export interface DashboardResponse {
  summary: { metrics: MetricCard[] }
  charts: { charts: Array<{ key: string; title: string; type: string; data: { items: MixItem[] } }> }
  trends: { series: Array<{ key: string; name: string; type: string; points: Array<{ time: string; value: number }> }> }
  dimension: { type: string; label: string }
}

// ---------------------------------------------------------------------------
// 通用请求参数
// ---------------------------------------------------------------------------
export interface QueryScope {
  timeRange: DateRange
  departmentIds: string[]
  userIds: string[]
}

export interface MockMeta {
  generatedAt: string
  referenceDay: string
  windowDays: number
  seed: number
  enterpriseId: string
  enterpriseName: string
  note: string
}

export interface QuotaSummaryRow {
  userId: string
  userName: string
  cycleLimit: number | null
  cycleLimitDisplay: string
  totalUsed: number
  __quotaUsageRate: number | null
  departmentName?: string
  riskLevel?: 'high' | 'medium' | 'low' | 'unlimited'
}

export interface AuditEntry {
  at: string
  action: string
  departmentId?: string | null
  limitType: string
  newLimit?: number | null
  affectedCount: number
}
