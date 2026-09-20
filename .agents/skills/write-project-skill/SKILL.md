---
name: write-project-skill
description: Use when adding or editing a skill under .agents/skills/ — "加个 skill"、"把这个流程固化成 skill"、"skill 没被加载"、"更新 AGENTS.md 的 skill 表". Covers the project skill root, frontmatter that actually triggers, and the branch-driven split that keeps a skill loadable.
whenToUse: 需要把本项目里某个反复出现的流程沉淀成 skill，或排查 skill 未被发现/未被触发时。
metadata:
  project: ai-efficiency-console
---

# 编写本项目级 skill

项目 skill 放在 **`.agents/skills/<name>/SKILL.md`**（单层扫描：只识别
`<root>/<name>/SKILL.md` 与 `<root>/<name>.md`，**嵌套的 `**/SKILL.md` 不会被发现**）。
写完后新的 skill 会在下一轮自动出现在会话目录里，无需重启。

通用写作方法（context pointer、information hierarchy、leading words、pruning）由
`writing-for-agents` 承载 —— skill 机制与 invocation 选择以它为准。本 skill 只记录
**本项目的落点与约定**。

## 完成标准

- 目录为 `.agents/skills/<kebab-case-name>/SKILL.md`，frontmatter 有 `name` 与 `description`；
- `description` 里含**真实触发词**（用户可能说的中文原话），而不是功能描述；
- 需要时把按需材料放进同 bundle 的 `references/`，正文用相对路径指向它；
- `AGENTS.md` §4 的 skill 表已新增一行，且 `SKILLS.md` 索引已同步；
- 在会话中确认它出现在 skill catalog 里（写完即生效，可直接观察）。

## 本项目的落点约定

| 内容 | 放哪 |
|---|---|
| 何时用、步骤顺序、完成标准 | `SKILL.md` 正文（steps） |
| 字段/口径长表、代码骨架、命令清单 | `references/*.md`（disclosed reference） |
| 不可违反的原则（口径六原则等） | `docs/PRINCIPLES.md` 单一事实来源，skill 里只指路不复述 |
| 命令清单 | 环境即真相（`package.json` scripts / `server.py --help`），skill 里给单条最关键的即可 |

复述 `AGENTS.md` 或 `docs/` 已有的内容会让 pointer 变重却不多带信息 —— 指向它即可。

## 一个 skill 的骨架

```markdown
---
name: kebab-case-name
description: Use when <触发场景> — "<用户可能说的原话1>"、"<原话2>". <产出什么>.
whenToUse: <一句话补充，可省>
---

# 标题（用动词短语）

<一段话说清这个 skill 解决的问题，以及为什么值得固化成流程>

## 完成标准

<可检查 + 穷尽：列出结束时的交付物，让 agent 能判断 done / not-done>

## 步骤

### 1. ...
### 2. ...

## 反模式（可选）

| 反模式 | 为什么错 |
```

写 `description` 时把**触发的词放最前面**，并让每个 branch 有自己的触发词；
同义词只是重命名同一个 branch 时合并它们。

## 让步骤可被判定的两个杠杆

- **完成标准要可检查且穷尽**：写「每个改动字段都能在 `/metrics` 找到定义」，
  而不是「检查一下口径」。前者逼出实际动作，后者会被跳过。
- **按 branch 拆分**：`add-metric` 把「只暴露已有字段 / 新增原始字段 / 跨维度聚合」
  写成三个分支，agent 只需读它命中的那一个。把三类混成一段会让每一步都变模糊。
