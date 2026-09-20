# SKILLS.md —— 项目级 skill 索引

> 本文件是**给人看的可见入口**。skill 本体位于 **`.agents/skills/<name>/SKILL.md`**。
> `.agents` 目录此前在 Finder 里是隐藏的，已用 `chflags nohidden .agents` 解除；
> 若仍看不到，按 `⌘ + ⇧ + .` 显示隐藏文件，或终端 `ls -a`。

## 为什么是 `.agents/skills` 而不是 `.agent`

| 依据 | 说明 |
|---|---|
| 本机既有约定 | 你的用户级 skill 就在 `~/.agents/skills/`（`writing-for-agents`、`tdd`、`research` 等 16 个），项目级沿用同一复数形式 |
| 生态标准 | `.agents/skills/` 是 agent-skills 约定的项目根，`.dsh/skills/` 是 DSH 私有根，两者都会被扫描 |
| 扫描规则 | **只扫一层**：识别 `<root>/<name>/SKILL.md` 与 `<root>/<name>.md`；嵌套的 `**/SKILL.md` 不会被发现 |
| 生效方式 | 写入即生效，无需重启（本会话的 skill 目录已实时包含下面 4 个） |

## 本项目的 4 个 skill

| skill | 何时触发 | 内容 |
|---|---|---|
| `add-metric` | 「加一个指标」「把采纳率换成按字符口径」「这个数要按部门拆」 | 六步流水线：口径 → 聚合 → 接口 → 类型 → 页面 → 口径页；含三个分支与反模式清单 |
| | | 附 `references/data-dictionary.md`：原始字段 → 聚合字段 → 接口字段的三层映射 |
| `verify-dashboard-data` | 「这个数对吗」「部门加起来对不上」「接真实接口前校验一下」 | 三项硬校验（汇总一致 / 比率口径 / 周期对齐）的可复现命令 + 常见误判表 |
| `develop-frontend-page` | 「加一个页面」「图表配色不对」「筛选器要共享」 | 数据层边界、全局筛选契约、表格与图表规范、渲染自检 |
| | | 附 `references/chart-recipes.md`：折线/双轴/堆叠柱/环形/散点 的可复制写法 |
| `write-project-skill` | 「加个 skill」「skill 没被加载」 | 本仓库 skill 的落点与格式；写作方法交给 `writing-for-agents` |

```
.agents/
└── skills/
    ├── add-metric/
    │   ├── SKILL.md
    │   └── references/data-dictionary.md
    ├── develop-frontend-page/
    │   ├── SKILL.md
    │   └── references/chart-recipes.md
    ├── verify-dashboard-data/
    │   └── SKILL.md
    └── write-project-skill/
        └── SKILL.md
```

## frontmatter 格式

```markdown
---
name: kebab-case-name          # 必填，kebab-case，需与目录名一致
description: Use when <触发场景> — "<用户可能说的原话>". <产出什么>.   # 必填，触发词放最前面
whenToUse: <一句话补充>         # 可选
metadata:                      # 可选
  project: ai-efficiency-console
---

# 标题（动词短语）
## 完成标准（可检查 + 穷尽）
## 步骤
```

## 新增 skill 的检查清单

- [ ] 目录 `.agents/skills/<kebab-case>/SKILL.md`，frontmatter 有 `name` + `description`
- [ ] `description` 含**真实触发词**（用户会说的原话），而不是功能描述
- [ ] 只写本项目特有的内容；`AGENTS.md` 已常驻的原则不复述，只指路
- [ ] 需要按需查阅的长表/骨架放进同 bundle 的 `references/`
- [ ] 更新 `AGENTS.md` §7 的 skill 表、本文件（`SKILLS.md`）的索引
- [ ] 在会话中确认它出现在 skill 目录里（写入即生效，可直接观察）
