import { useState } from 'react'
import { Card, CardHeader, Badge } from '../components/Card'
import { PageShell } from '../components/Layout'
import { cx } from '../lib/format'
import { API_SOURCES, AVAILABILITY_META, DATA_GAPS } from '../lib/interfaceCatalog'

interface MetricDoc {
  group: string
  name: string
  field: string
  formula: string
  source: string
  caliber: string
  caveat?: string
}

/**
 * 指标口径登记表。
 * 页面上的每一个数字都必须能在这里找到定义、公式与数据来源，避免「看板数字对不上」的扯皮。
 */
const METRICS: MetricDoc[] = [
  // —— 用量与成本 ——
  {
    group: '用量与成本',
    name: 'AI 用量消耗（Credits）',
    field: 'credit / totalUsed',
    formula: 'Σ(对话消耗 + 补全消耗 + 生成消耗)',
    source: 'usage/members/query（totalUsed）',
    caliber: '按企业额度周期的计量单位聚合；部门级由成员级求和，不做二次估算。',
    caveat: '积分与「金额」不是同一概念，需结合 remainingRatio 判断余额健康度。',
  },
  {
    group: '用量与成本',
    name: 'Token 消耗',
    field: 'token_usage',
    formula: 'input_token + output_token',
    source: 'observability/metric-summary（token_usage）',
    caliber: '全部模型调用的输入输出 token 之和，cache_read_input_token 单独统计不重复计入。',
    caveat: 'Token 与 Credits 的换算比例随时间/模型变化，跨月比较消耗金额时要注意单价变动。',
  },
  {
    group: '用量与成本',
    name: '千行成本',
    field: 'creditsPerKline',
    formula: 'Credits 消耗 ÷ (新增代码行数 ÷ 1000)',
    source: '派生指标（由上述两者计算）',
    caliber: '衡量「单位代码产出的花费」，是识别高耗低产部门的核心指标。',
    caveat: '非编码岗位（产品、运营）不产出代码，该指标会失真，需按部门类型区别解读。',
  },
  {
    group: '用量与成本',
    name: '额度使用率',
    field: '__quotaUsageRate',
    formula: '窗口消耗 ÷ 周期限量 × 100%',
    source: 'usage/members/query（cycleLimit + totalUsed）',
    caliber: 'cycleLimit 为 null 表示不限量，此时使用率不计算。',
    caveat: '窗口（如近 30 天）与额度周期（自然月/订阅切片）可能不对齐，提额决策应以额度周期为准。',
  },
  // —— 代码贡献 ——
  {
    group: '代码贡献',
    name: '新增代码总行数',
    field: 'totalNewCodeLines',
    formula: '补全采纳行数 + 生成插入行数（去重后）',
    source: 'dashboard/member/data（totalNewCodeLines）',
    caliber: '统计成员在窗口内实际留存的新增行，删除行不计入。',
    caveat: '行数受语言与格式化影响（Markdown、SQL 单行长度差异大），跨语言比较需谨慎。',
  },
  {
    group: '代码贡献',
    name: 'AI 生成代码行数',
    field: 'aiGenerateCodeLines',
    formula: 'AI 参与生成并被采纳/保留的行数',
    source: 'dashboard/member/data（aiGenerateCodeLines）',
    caliber: '包含补全采纳与对话/Craft 生成插入两部分。',
  },
  {
    group: '代码贡献',
    name: 'AI 代码占比（生成率）',
    field: 'codeGenerateRateByLines',
    formula: 'AI 生成代码行数 ÷ 新增代码总行数 × 100%',
    source: 'dashboard/member/data（codeGenerateRateByLines）',
    caliber: '本方案核心结论指标；聚合时**先求和再相除**，不使用个人占比的算术平均。',
    caveat: '占比高不等于产出高：需与「新增代码行数」「千行成本」联合看，避免只盯单一指标。',
  },
  {
    group: '代码贡献',
    name: 'AI 代码占比（按字符）',
    field: 'codeGenerateRateByChars',
    formula: 'aiGenerateCodeChars ÷ totalNewCodeChars × 100%',
    source: 'dashboard/member/data（codeGenerateRateByChars）',
    caliber: '按字符口径的辅助校验指标，与按行口径互相印证。',
    caveat: '两种口径差异过大（>10pt）时，通常意味着大量短行/长行插入，值得抽查。',
  },
  // —— 补全质量 ——
  {
    group: '补全与采纳',
    name: '补全生成次数',
    field: 'completionGenerateCount',
    formula: 'Σ 补全触发次数',
    source: 'dashboard/member/data（completionGenerateCount）',
    caliber: '反映使用频度，不代表质量。',
  },
  {
    group: '补全与采纳',
    name: '补全采纳率（按行）',
    field: 'completionAcceptRateByLines',
    formula: '补全采纳行数 ÷ 补全生成行数 × 100%',
    source: 'dashboard/member/data（completionAcceptRateByLines）',
    caliber: '衡量补全建议的有效性；聚合时先求和再相除。',
    caveat: '采纳率低可能是模型不适配语言、上下文不足或提示方式问题，需结合语言分布排查。',
  },
  {
    group: '补全与采纳',
    name: '补全采纳率（按次数/字符）',
    field: 'completionAcceptRateByCount / ByChars',
    formula: '采纳次数÷生成次数 / 采纳字符数÷生成字符数',
    source: 'dashboard/member/data',
    caliber: '三种口径并存用于交叉验证：次数口径看意愿，行数口径看效果，字符口径看体量。',
  },
  // —— 活跃与渗透 ——
  {
    group: '活跃与渗透',
    name: '活跃使用人数 / 日均活跃',
    field: 'activeUserNum / dau',
    formula: '窗口内产生过任意 AI 行为的去重成员数 / 日均值',
    source: 'dashboard/analytics/activity',
    caliber: '「活跃」定义为至少发生一次请求，不区分请求量大小。',
    caveat: '打开插件但未采纳建议也算活跃，因此活跃率高不代表提效充分。',
  },
  {
    group: '活跃与渗透',
    name: '席位使用率',
    field: 'license.used / license.total',
    formula: '已授权并活跃席位数 ÷ 当前有效席位总量',
    source: 'resources/overview',
    caliber: '用于判断是否存在「买了没用」的浪费席位。',
  },
  {
    group: '活跃与渗透',
    name: '对话次数',
    field: 'dialogCount',
    formula: 'Σ(Ask + Craft + Agent + 知识库 + 上下文 + 命令 + 动作 + 自定义)',
    source: 'dashboard/member/data（dialogCount）',
    caliber: '按能力维度可下钻，帮助判断使用深度（仅问答 vs 参与实际编码）。',
  },
  // —— 稳定性 ——
  {
    group: '稳定性与体验',
    name: '请求失败率',
    field: 'genai_request_error_rate',
    formula: '失败请求数 ÷ 总请求数 × 100%',
    source: 'observability/metric-summary',
    caliber: '来自 APM 口径，与企业管理后台「场景监控」一致。',
    caveat: '私有化部署未配置 APM 数据源时该指标不可用（接口返回 404 属预期降级）。',
  },
  {
    group: '稳定性与体验',
    name: '首 Token 时延',
    field: 'ttft_avg / ttft_p50 / p95 / p99',
    formula: '按请求粒度统计的平均值与分位数',
    source: 'observability/metric-summary',
    caliber: '反映交互体感；p95/p99 明显劣化时优先排查模型路由与网络。',
  },
  {
    group: '稳定性与体验',
    name: '工具调用失败率',
    field: 'tool_error_rate',
    formula: '工具调用失败次数 ÷ 工具调用总次数 × 100%',
    source: 'observability/metric-summary',
    caliber: '适用于 Agent / Craft 等带工具调用的场景。',
  },
]

const GROUPS = Array.from(new Set(METRICS.map((item) => item.group)))

export default function MetricsPage() {
  const [activeGroup, setActiveGroup] = useState<string>('全部')
  const shown = activeGroup === '全部' ? METRICS : METRICS.filter((item) => item.group === activeGroup)

  return (
    <PageShell
      title="指标口径说明"
      description="本页登记看板上所有指标的业务定义、计算公式与数据来源。任何数字争议都应回到本页对齐口径，而不是在页面上猜测。"
      actions={
        <Badge tone="brand">
          共 {METRICS.length} 个指标 · {API_SOURCES.length} 个数据来源 · {DATA_GAPS.length} 个能力缺口
        </Badge>
      }
    >
      <Card>
        <CardHeader
          title="四条不可违反的口径原则"
          subtitle="这些原则决定了看板数字能否被信任"
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {[
            {
              title: '先求和再相除',
              body: '所有比率型指标（AI 代码占比、采纳率）都由聚合后的分子分母相除得到，绝不取个人比率的算术平均，避免辛普森悖论。',
            },
            {
              title: '部门 = 成员之和',
              body: '部门级与公司级指标一律由成员日粒度求和得到，保证「部门汇总之和 == 公司总量」，任何对不齐都视为缺陷。',
            },
            {
              title: '消耗与产出成对出现',
              body: '任何展示 AI 代码占比的地方都必须能同时看到消耗（Credits）与绝对产出（代码行数），避免用单一比率下结论。',
            },
            {
              title: '环比区间等长',
              body: '环比对照周期与当前窗口严格等长且紧邻（如近 30 天 vs 前 30 天），不做年初至今等非等长对比。',
            },
          ].map((item) => (
            <div key={item.title} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
              <p className="flex items-center gap-2 text-xs font-semibold text-slate-100">
                <span className="h-3 w-1 rounded-full bg-brand-500" />
                {item.title}
              </p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">{item.body}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="指标字典"
          subtitle="字段名与 document.yaml 保持一致的，可直接对照接口文档核验"
          extra={
            <div className="flex flex-wrap items-center gap-1.5">
              {['全部', ...GROUPS].map((group) => (
                <button
                  key={group}
                  type="button"
                  onClick={() => setActiveGroup(group)}
                  className={cx(
                    'rounded-lg px-2.5 py-1.5 text-[11px] ring-1 transition-colors',
                    activeGroup === group
                      ? 'bg-brand-500/90 text-white ring-brand-400/50'
                      : 'bg-white/[0.04] text-slate-300 ring-white/[0.07] hover:text-white',
                  )}
                >
                  {group}
                </button>
              ))}
            </div>
          }
        />
        <div className="space-y-2.5">
          {shown.map((metric) => (
            <div key={metric.name} className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-slate-100">{metric.name}</span>
                <Badge tone="neutral">{metric.group}</Badge>
                <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300">{metric.field}</code>
              </div>
              <dl className="mt-2.5 grid grid-cols-1 gap-x-6 gap-y-1.5 text-[11px] lg:grid-cols-2">
                <div className="flex gap-2">
                  <dt className="w-14 shrink-0 text-slate-500">计算公式</dt>
                  <dd className="font-mono text-slate-200">{metric.formula}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-14 shrink-0 text-slate-500">数据来源</dt>
                  <dd className="text-slate-300">{metric.source}</dd>
                </div>
                <div className="flex gap-2 lg:col-span-2">
                  <dt className="w-14 shrink-0 text-slate-500">口径说明</dt>
                  <dd className="leading-relaxed text-slate-300">{metric.caliber}</dd>
                </div>
                {metric.caveat && (
                  <div className="flex gap-2 lg:col-span-2">
                    <dt className="w-14 shrink-0 text-amber-500/80">注意</dt>
                    <dd className="leading-relaxed text-amber-200/80">{metric.caveat}</dd>
                  </div>
                )}
              </dl>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="数据来源与可获取性"
          subtitle="看板每个数字对应的企业接口。「部门维度」列是本项目最容易踩坑的地方：消耗维度可按部门直查，效能维度必须 rollup，稳定性维度当前拿不到"
          extra={
            <div className="flex items-center gap-1.5">
              {(['direct', 'aggregate', 'missing'] as const).map((key) => (
                <Badge key={key} tone={AVAILABILITY_META[key].tone}>
                  {AVAILABILITY_META[key].label}
                </Badge>
              ))}
            </div>
          }
        />
        <div className="overflow-auto">
          <table className="w-full min-w-[1080px] border-collapse text-[12px]">
            <thead>
              <tr className="text-slate-400">
                <th className="border-b border-white/[0.07] px-3 py-2 text-left font-medium">分析场景</th>
                <th className="border-b border-white/[0.07] px-3 py-2 text-left font-medium">接口</th>
                <th className="border-b border-white/[0.07] px-3 py-2 text-left font-medium">关键字段</th>
                <th className="border-b border-white/[0.07] px-3 py-2 text-left font-medium">部门维度</th>
                <th className="border-b border-white/[0.07] px-3 py-2 text-left font-medium">可获取性</th>
                <th className="border-b border-white/[0.07] px-3 py-2 text-left font-medium">接入约束</th>
              </tr>
            </thead>
            <tbody>
              {API_SOURCES.map((row) => {
                const meta = AVAILABILITY_META[row.availability]
                return (
                  <tr key={row.path + row.scene} className="align-top hover:bg-white/[0.03]">
                    <td className="border-b border-white/[0.04] px-3 py-2.5 text-slate-200">{row.scene}</td>
                    <td className="border-b border-white/[0.04] px-3 py-2.5">
                      <span className="mr-1.5 rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                        {row.method}
                      </span>
                      <span className="font-mono text-[11px] leading-relaxed text-cyan-300">{row.path}</span>
                    </td>
                    <td className="border-b border-white/[0.04] px-3 py-2.5 text-[11px] leading-relaxed text-slate-300">
                      {row.fields}
                    </td>
                    <td
                      className={cx(
                        'border-b border-white/[0.04] px-3 py-2.5 text-[11px] leading-relaxed',
                        row.department.startsWith('★')
                          ? 'text-mint-300'
                          : row.department.startsWith('✗')
                            ? 'text-rose-300'
                            : 'text-slate-400',
                      )}
                    >
                      {row.department}
                    </td>
                    <td className="border-b border-white/[0.04] px-3 py-2.5">
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </td>
                    <td className="border-b border-white/[0.04] px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/70">
                      {row.constraint}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="接口能力缺口与处置"
          subtitle="已逐条核对 document.yaml 确认的边界；完整推导过程与证据见根目录 docs/DATA-MAPPING.md"
        />
        <div className="space-y-2.5">
          {DATA_GAPS.map((gap) => (
            <div key={gap.id} className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="rose">{gap.id}</Badge>
                <span className="text-[13px] font-semibold text-slate-100">{gap.title}</span>
              </div>
              <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 text-[11px] lg:grid-cols-[auto_1fr]">
                <dt className="text-slate-500">现状</dt>
                <dd className="leading-relaxed text-slate-300">{gap.detail}</dd>
                <dt className="text-slate-500">处置</dt>
                <dd className="leading-relaxed text-mint-300/90">{gap.action}</dd>
              </dl>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="当前实现的已知边界" subtitle="接口未就绪阶段的取舍，接入真实接口时需逐项确认" />
        <ul className="space-y-2 text-[11px] leading-relaxed text-slate-300">
          {[
            '数据为 mock：由 backend/app/gen_mock.py 按固定种子生成，日粒度 180 天，共 6 个部门 / 48 名成员，所有字段量与真实接口同构。',
            '部门消耗维度可直接获取：/openapi/usage/members/detail 原生支持 departmentIds 过滤且出参含部门详情；但效能维度（代码量 / 采纳率）所在接口无部门入参，必须由后端按成员 rollup。',
            '部门级稳定性指标当前拿不到：可观测域 groupBy 不支持 department（应用身份无组织语义），故部门页不展示失败率与时延，这些指标只在企业级展示。',
            '「代码提交行数」采用接口已有的新增代码总行数口径（totalNewCodeLines），未接入 Git 平台的 commit / diff 数据；若后续需要与代码仓库对账，可在此基础上接入 GitLab/GitHub 事件做二次校验。',
            '「真实提效」无法由行数单独证明：AI 代码占比高只说明采纳多，建议后续结合需求吞吐（故事点/需求数）、缺陷率与交付周期做三角验证。',
            '额度周期的时区与切分：接口时间均为东八区 RFC3339，cycleStart 含、cycleEnd 不含；看板窗口与额度周期可能不对齐，提额决策请以额度周期为准。',
            '可观测域在私有化部署未配置 APM 时返回 404 属预期降级，前端需对这种「指标不可用」做空态展示而不是显示 0。',
          ].map((item) => (
            <li key={item} className="flex gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500/70" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </Card>
    </PageShell>
  )
}
