# AGENTS.md —— AI 效能运营台

本文件是**总览与路由**：说明这个项目是什么、怎么跑起来、每类问题该看哪份文档。
**详细内容不放在这里** —— 见 §2 的文档地图与 §4 的 skill。

---

## 1. 项目速览

面向研发管理者的**部门级 AI 用量与代码贡献占比分析看板**：在任意时间范围内回答
「哪个部门/谁在消耗 AI 额度、消耗换来了多少代码产出、AI 占新增代码的比例、额度要不要调」。

| 项 | 值 |
|---|---|
| 前端 | React 18 + TypeScript（strict）+ Vite + Tailwind + ECharts |
| 后端 | Python 3，**仅标准库**（不得引入 `requirements.txt`） |
| 数据 | 企业 OpenAPI（`document.yaml`，只读附件）**暂无数据** → 用 mock 数据集 |
| 形态 | 前后端 + mock 服务同仓；5 个页面 + 1 个成员详情抽屉 |

```bash
cd ai-efficiency-console
python3 backend/app/gen_mock.py            # ① 生成 mock 数据集（生成物，不入库，必须先跑）
python3 backend/app/server.py --selftest   # ② 后端接口 + 口径一致性自检
python3 backend/app/server.py --port 8000  # ③ 启动；同时托管 frontend/dist
cd frontend && npm install && npm run dev   # 开发态 5173（已代理 /api）
npm run typecheck && npm run build          # 提交前必跑
npm run verify -- http://127.0.0.1:8000     # 无头 Chrome 逐页渲染自检
```

> `npm install` 报缓存不可写时追加 `--cache ../.npm-cache`。

## 2. 文档地图（先查这里，再动手）

| 我想知道 | 看这份 |
|---|---|
| **改代码的硬性规则**（口径六原则、违约判据） | `docs/PRINCIPLES.md` |
| **怎么写代码**（分层职责、错误码、TS/React 约定） | `docs/CONVENTIONS.md` |
| **某段代码该放哪一层 / 目录布局** | `docs/LAYOUT.md` |
| **某个数能不能拿到 / 部门维度支不支持** | `docs/DATA-MAPPING.md` ★ |
| **为什么这么设计**（页面设计、指标口径、验收标准） | `docs/DESIGN.md` |
| **接口契约**（路径、参数、响应、自检） | `docs/API.md` |
| **有哪些项目级 skill** | `SKILLS.md` |
| 当前已实现的接口清单 | `backend/app/server.py` 顶部注释 |

企业 OpenAPI 原始文档 `document.yaml` **不在本仓库内**（只读附件）；
需要核对字段时从 `docs/DATA-MAPPING.md` 反查。

## 3. 架构一屏

```
浏览器  React + TS（5 页面，全局筛选由 ScopeContext 统一）
   │  /api/**（Vite 代理 → 127.0.0.1:8000）
Python 后端（零依赖）
   ├── metrics.py  口径唯一实现：成员日粒度 → 部门/公司 rollup
   ├── server.py   路由 / 校验 / 错误语义 / 静态托管 / --selftest
   └── DataSource  mock JSON ⇄ 企业 OpenAPI（二期只换这一处）
```

**唯一的关键约束**：页面不做聚合，口径只在 `metrics.py` 有一份实现。

## 4. 项目级 skill

位置 `.agents/skills/<name>/SKILL.md`（隐藏目录；Finder 按 `⌘ + ⇧ + .`，可见索引见 `SKILLS.md`）。
写入即生效，无需重启。frontmatter 必填 `name`（kebab-case）与 `description`（含触发词）。

| skill | 何时触发 |
|---|---|
| `add-metric` | 新增/改动任何看板指标（六步流水线 + 反模式清单） |
| `verify-dashboard-data` | 数字被质疑、交付前校验、切换数据源 |
| `develop-frontend-page` | 新增/修改页面与组件 |
| `write-project-skill` | 新增项目级 skill |

新增 skill 后同步更新本表与 `SKILLS.md`。

## 5. 变更检查清单

```bash
cd ai-efficiency-console
python3 backend/app/server.py --selftest          # 后端：接口 + 口径一致性
cd frontend && npm run typecheck && npm run build # 前端：类型 + 构建
npm run verify -- http://127.0.0.1:8000           # 渲染自检（截图在 frontend/verification/）
```

- [ ] 动了聚合口径 → `--selftest` 的「部门/成员/公司汇总一致」必须仍通过
- [ ] 动了指标定义 → 同步 `frontend/src/pages/MetricsPage.tsx` 的指标字典
- [ ] 新增页面/字段/接口 → 更新 `docs/DESIGN.md` 或 `docs/API.md` 对应章节
- [ ] 新增静态路由 → `/` 与 SPA 深链（如 `/members/xxx`）仍返回 `index.html`；
      `/api/**` 与 `/healthz` 才是接口路径（历史上这里出过 bug，已加 HTTP 层自检）
- [ ] 新增会产出的文件/目录 → 用 `git check-ignore -v <path>` 确认已被忽略
- [ ] 动了交互（弹层 / 折叠 / 抽屉）→ `npm run verify` 的交互断言必须通过，
      渲染快照通过 ≠ 交互正确（「筛选弹层不收起」就是只跑快照漏掉的 bug）
- [ ] 新增 skill → 更新本文件 §4 与 `SKILLS.md`

## 6. 已知边界（别试图「修好」）

结论级提醒；完整证据与处置见 `docs/DATA-MAPPING.md` §4。

- **部门维度分三类**：消耗可按部门直查（`usage/members/detail` 支持 `departmentIds`）；
  效能必须 rollup（`dashboard/member/data` 无部门入参）；**稳定性拿不到**
  （可观测域 `groupBy` 不支持 `department`），故部门页不展示失败率与时延。
- **`usage/members/query` 用 `userIds`（UUID）**：`userNames` 遇全半角/emoji 会静默不匹配。
- **私有化未配 APM 时可观测域返回 404**，属预期降级 → 展示「不可用」而非 0。
- **「代码提交行数」= `totalNewCodeLines`**（编辑器内新增行），**不是 Git commit diff**；
  要 Git 口径需新增数据源。
- **AI 代码占比 ≠ 提效幅度**：必须与消耗、绝对产出配对展示，禁止包装成绩效结论。
- **数据集不入库**：生成物、窗口终点默认取运行当天；需复现时
  `AEC_REFERENCE_DAY=YYYY-MM-DD python3 backend/app/gen_mock.py`。
