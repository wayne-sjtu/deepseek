# 目录布局与职责边界（Layout）

> 面向对象：要新增文件、或不确定某段代码该放哪一层的人（含代理）。
> 编排见 `../AGENTS.md`，编码细节见 `CONVENTIONS.md`。

```
deepseek/                                  # 仓库根 = 工作区根
├── .gitignore                             # 忽略规则单一事实来源（应用内不再单独放）
├── AGENTS.md                              # 总览与路由（详细内容在 docs/）
├── SKILLS.md                              # 项目级 skill 的可见索引
├── .agents/skills/                        # 项目级 skill（按需加载）
│   ├── add-metric/                        #   + references/data-dictionary.md
│   ├── develop-frontend-page/             #   + references/chart-recipes.md
│   ├── verify-dashboard-data/
│   └── write-project-skill/
├── docs/                                  # 跨应用的文档（为什么放根见文末）
│   ├── PRINCIPLES.md                      # 口径六原则：为什么 + 违约判据
│   ├── CONVENTIONS.md                     # 工程约定：Python / TS / 文档 / skill
│   ├── LAYOUT.md                          # 本文件：目录与职责边界
│   ├── DESIGN.md                          # 设计方案：目标、口径、页面设计、验收
│   ├── API.md                             # 接口契约：路径、参数、响应、自检
│   └── DATA-MAPPING.md                    # 指标 → 接口的获取方式与能力缺口
└── ai-efficiency-console/                 # 应用代码
    ├── README.md                          # 应用说明与快速开始
    ├── data/                              # mock 数据集（生成物，只提交 .gitkeep）
    │   └── samples/                       # 需归档的样例数据放这里（入库）
    ├── backend/app/
    │   ├── gen_mock.py                    # ① 数据生成（固定种子；窗口终点默认取当天）
    │   ├── metrics.py                     # ② 口径唯一实现：成员日粒度 → 部门/公司
    │   ├── server.py                      # ③ 路由 + 校验 + 静态托管 + --selftest
    │   └── __pycache__/                   # 忽略
    └── frontend/
        ├── index.html  package.json  vite.config.ts  tsconfig.json
        ├── tailwind.config.js  postcss.config.js  .env.example
        ├── public/favicon.svg
        ├── scripts/verify-pages.mjs       # 无头 Chrome 逐页渲染自检
        ├── src/
        │   ├── main.tsx  App.tsx  vite-env.d.ts
        │   ├── lib/                       # 数据访问层与纯逻辑（无 JSX）
        │   │   ├── api.ts                 # ★ 唯一取数入口
        │   │   ├── ScopeContext.tsx       # ★ 全局筛选单一事实来源
        │   │   ├── types.ts               # 领域类型
        │   │   ├── format.ts              # 数字/时间格式化
        │   │   ├── theme.ts               # 颜色与图表主题
        │   │   └── interfaceCatalog.ts    # 接口目录（驱动口径页渲染）
        │   ├── components/                # 可复用展示层
        │   └── pages/                     # 5 个页面
        ├── dist/                          # 构建产物（忽略）
        └── verification/                  # 自检截图（忽略）
```

## 职责边界（改代码前先定位层次）

### 仓库根：放「跨应用、人先看」的东西

| 路径 | 职责 | 不该放什么 |
|---|---|---|
| `AGENTS.md` | 总览与路由 | 长篇说明 |
| `SKILLS.md` | skill 索引 | skill 正文 |
| `docs/` | 设计、接口、口径、约定、布局 | 代码 |
| `.agents/skills/` | 按需加载的流程 | 业务代码 |
| `.gitignore` | 忽略规则单一事实来源 | — |
| `ai-efficiency-console/` | 应用代码 | 跨应用文档 |

### 后端：三层，不可越界

| 文件 | 职责 | 不该放什么 |
|---|---|---|
| `gen_mock.py` | 产出 mock 数据（固定种子可复现） | 业务聚合逻辑 |
| `metrics.py` | **口径的唯一实现**（rollup、比率、分组） | HTTP、路由、JSON 包装 |
| `server.py` | 路由、参数校验、错误语义、静态托管、自检 | 指标计算公式 |
| `DataSource`（在 `server.py` 内） | 数据源抽象：mock JSON ⇄ 企业 OpenAPI | 聚合口径 |

> 二期接真实接口时**只改 `DataSource`**，`metrics.py` 不动 —— 它只依赖字段形状。

### 前端：lib（逻辑）→ components（展示）→ pages（组装）

| 路径 | 职责 | 不该放什么 |
|---|---|---|
| `lib/api.ts` | **唯一取数入口** | 聚合计算、组件 |
| `lib/ScopeContext.tsx` | 全局筛选（时间范围/部门） | 页面局部状态 |
| `lib/typeFormat/theme` | 类型、格式化、主题 | 业务判断 |
| `components/` | 可复用展示（Card / Chart / DataTable / MetricCard / FilterBar / Layout） | 调用接口 |
| `pages/` | 页面组装与交互 | 重复实现聚合口径 |

> **硬约束**：页面不做聚合。任何新口径都先在 `metrics.py` 落地，
> 再经 `lib/types.ts` 暴露到页面。违反它会同时破坏 `PRINCIPLES.md` 的 M1 与 M2。

## 为什么 `docs/` 在仓库根而不是应用内

1. `docs/` 里描述的是**整个项目**（含代理协作方式、数据来源与口径），不只是应用；
2. 与 `AGENTS.md` / `SKILLS.md` 同级，找文档时不用先猜它在哪一层；
3. 代理读约定文件时少跨一层目录，少一次路径判断。

## 新增文件时的判断顺序

1. 它是**生成物**吗？→ 放应用内，并确认 `.gitignore` 覆盖（`git check-ignore -v`）。
2. 它是**跨应用的知识**吗？→ 放仓库根 `docs/`，按文档地图选对应那一份。
3. 它是**某个流程的操作步骤**吗？→ 做成 `.agents/skills/<name>/SKILL.md`。
4. 否则按上面的职责表放应用内对应层；拿不准就看该层「不该放什么」。
