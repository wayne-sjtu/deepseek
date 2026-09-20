# AI 效能运营台（AI Efficiency Console）

面向研发管理者的 **部门级 AI 用量与代码贡献占比分析看板**：在任意时间范围内回答
「哪个部门/谁在消耗 AI 额度、消耗换来了多少代码产出、AI 占新增代码的比例是多少、额度要不要调」。

- 前端：React 18 + TypeScript + Vite + Tailwind CSS + ECharts
- 后端：Python 3（**标准库，零第三方依赖**）—— 负责部门 rollup 与口径校验
- 数据：**企业接口暂无数据**，当前以确定性 mock 数据集跑通全链路，字段口径与 `document.yaml` 逐字对齐

---

## 快速开始（3 步）

```bash
# 1) 后端：先生成数据，再自检 + 启动（默认 127.0.0.1:8000，同时托管前端构建产物）
python3 backend/app/gen_mock.py                 # 数据集是生成物，不入库，必须先跑
python3 backend/app/server.py --selftest
python3 backend/app/server.py --port 8000

# 2) 前端：开发态（127.0.0.1:5173，已配置 /api 代理到 8000）
cd frontend && npm install && npm run dev

# 3) 或：生产构建后直接由后端同源访问 http://127.0.0.1:8000/
cd frontend && npm run build
```

> 注意地址写法：根路径就是应用入口 `http://127.0.0.1:8000/`；
> `/api/**` 与 `/healthz` 才是接口路径（把 `/` 当接口请求会得到 404 JSON）。
> 刷新任意前端路由（如 `/members/xxx`）都会回退到 `index.html`，可直接分享链接。

> mock 数据集**不入库**（生成物，入库当天就过期）：窗口终点默认取运行当天，固定种子保证数值可复现；
> 需要字节级复现时用 `AEC_REFERENCE_DAY=2026-09-20 python3 backend/app/gen_mock.py` 钉住日期。
>
> 若 `npm install` 报 npm 缓存目录不可写，追加 `--cache ../.npm-cache` 即可。

---

## 页面

| 路由 | 页面 | 回答的问题 |
|---|---|---|
| `/overview` | 用量总览 | 钱花在哪、产出如何、哪个部门要复盘 |
| `/departments` | 部门效能 | 消耗-产出四象限诊断 + 部门明细横向对比 |
| `/members` | 个人效能 | 逐人代码行数 / AI 占比 / 采纳率 / 消耗；点击进入效能详情抽屉 |
| `/quota` | 额度管理 | 超限风险分档 + 成员/部门批量调整额度 + 审计 |
| `/metrics` | 指标口径 | 每个指标的定义、公式、来源与已知边界 |

所有页面共享顶部筛选条（时间范围 + 部门范围），保证口径一致、切页不丢筛选。

---

## 目录结构

文档与代理约定在**仓库根**（与 `ai-efficiency-console/` 同级），应用代码在 `ai-efficiency-console/`：

```
deepseek/                                  # 仓库根
├── .gitignore                             # 忽略规则单一事实来源
├── AGENTS.md                              # 代理常驻约定：目录职责、口径原则、变更检查清单
├── SKILLS.md                              # 项目级 skill 的可见索引（含新增 skill 检查清单）
├── .agents/skills/                        # 项目级 skill（按需加载，含触发词）
│   ├── add-metric/                        #   + references/data-dictionary.md
│   ├── develop-frontend-page/             #   + references/chart-recipes.md
│   ├── verify-dashboard-data/
│   └── write-project-skill/
├── docs/                                  # 文档索引见 docs/README.md
│   ├── PRINCIPLES.md                      # ★ 口径六原则：为什么 + 违约判据
│   ├── CONVENTIONS.md                     # 工程约定：分层、错误码、TS/React
│   ├── LAYOUT.md                          # 目录布局与职责边界
│   ├── DATA-MAPPING.md                    # ★ 数据可获取性：指标 → 接口、能力缺口
│   ├── DESIGN.md                          # 设计方案：目标、口径、页面设计、验收标准
│   └── API.md                             # 接口契约：路径、参数、响应、自检
└── ai-efficiency-console/                 # 应用代码
    ├── data/                              # mock 数据集（生成物，只提交 .gitkeep；samples/ 可归档）
    ├── backend/app/
    │   ├── gen_mock.py                    # mock 数据生成器（组织/成员/日粒度指标）
    │   ├── metrics.py                     # 指标聚合层（部门/成员/公司口径的唯一实现）
    │   └── server.py                      # HTTP 服务 + 21 个接口用例自检
    └── frontend/
        ├── src/lib/                       # api（数据访问层）/ types / format / theme / ScopeContext
        ├── src/components/                # Chart / Card / DataTable / MetricCard / FilterBar / Layout
        ├── src/pages/                     # 5 个页面
        └── scripts/verify-pages.mjs       # 无头 Chrome 页面自检（截图 + 控制台错误）
```

> `docs/` 放在仓库根而不是应用内：它描述的是**整个项目**（含代理协作方式、数据来源与口径），
> 与 `AGENTS.md` / `SKILLS.md` 同级更符合直觉。

### AI 项目规范（面向编码代理）

| skill | 何时触发 |
|---|---|
| `add-metric` | 新增/改动任何看板指标（六步流水线：口径 → 聚合 → 接口 → 类型 → 页面 → 口径页） |
| `verify-dashboard-data` | 数字被质疑、交付前校验、数据源切换 |
| `develop-frontend-page` | 新增/修改页面与组件 |
| `write-project-skill` | 新增项目级 skill |

skill 只写「本项目特有的东西」；通用写作方法由 `writing-for-agents` 承载。
`.agents/` 是隐藏目录，macOS Finder 里按 `⌘ + ⇧ + .` 显示，或直接看 `SKILLS.md`。

---

## 设计要点（为什么这么做）

1. **部门口径必须由后端 rollup**：企业 OpenAPI 的可观测域不支持 `groupBy=department`
   （应用身份无组织语义），成员级数据里的部门字段只能由调用方聚合。把聚合放在后端，
   口径只有一份实现，接入真实接口时页面零改动。
2. **先求和再相除**：所有比率都由聚合后的分子/分母相除，绝不取个人比率的算术平均。
   `--selftest` 会自动校验「部门汇总 == 成员汇总 == 公司总量」。
3. **消耗与产出成对出现**：任何展示 AI 代码占比的位置都能同时看到 Credits 消耗与绝对产出，
   避免用单一比率下结论（占比高 ≠ 提效）。
4. **额度风险按额度周期算**：窗口消耗 ÷ 周期限量会和「自然月/订阅切片」错配，
   因此额度页默认对齐额度周期，并保留跟随看板窗口的开关。
5. **数字语义要显式**：消耗类指标的环比上涨显示红色（成本↑不是好事）；
   比率变化用 **pp（百分点）** 而不是 %；每个 KPI 都带说明气泡与迷你趋势线。

每个数字都能在 `/metrics` 页找到定义与来源 —— 这是这类看板能被业务方信任的前提。

---

## 接入真实接口（二期）

后端已把数据源抽象为 `DataSource`，页面只依赖 `frontend/src/lib/api.ts` 的强类型函数：

1. 在 `DataSource` 中把读取 mock JSON 换成调用企业 OpenAPI（`document.yaml` 的 12 大域）；
2. `metrics.py` 的聚合逻辑**无需改动**（它只依赖成员日粒度的字段口径）；
3. 前端在 `frontend/.env.local` 中切换：

```bash
VITE_DATA_MODE=live
VITE_ENTERPRISE_ID=<真实企业 ID>
VITE_API_BASE=            # 留空表示同源
```

注意事项：企业 OpenAPI 仅支持 **admin 开发平台创建的企业级应用（应用身份）** 调用，
个人 API Key 会返回 401，因此 token 必须保存在服务端，不下发到浏览器。

---

## 验收状态

| 项 | 结果 |
|---|---|
| 后端 21 个接口用例 | 全部通过 |
| 汇总口径一致性（部门/成员/公司） | 误差 < 0.01 ✅ |
| 前端 TypeScript 严格模式 | 0 error ✅ |
| 生产构建 | 成功（echarts 单独分包）✅ |
| 5 个页面 + 成员详情抽屉无头渲染 | 无控制台错误、无失败请求、关键文案齐全 ✅ |
| 界面截图 | `frontend/verification/*.png` |
