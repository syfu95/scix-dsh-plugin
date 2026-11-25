# scix-dsh-plugin

面向 DeepSeek Harness（DSH）的 SciX / NASA ADS 文献插件：把文献检索、引用网络分析与全文阅读嵌入 DSH 的对话与研究工作流。

**中文** | [English](README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 项目定位

本插件在合规前提下，把 SciX / NASA ADS 的检索、引用网络分析与全文阅读能力嵌入 DSH 的对话与研究工作流。插件**不替代用户的判断**，而是提供可追溯、可验证的文献操作工具：bibcode、DOI、arXiv id 等标识符一律来自 API 原始响应，可在 ADS/SciX 网页端逐条核对。

SciX 与 ADS 使用同一套 API（SciX 官方帮助明确说明 “SciX uses the same API as ADS”）。插件默认服务地址为 `https://api.adsabs.harvard.edu/v1`。

## 硬性约束

以下约束在任何情况下不得违反（见 [Agent.md](Agent.md) §2）：

1. **永不下载、不缓存、不转存 PDF 全文文件。** ADS/SciX 服务条款禁止系统性下载文章。插件只通过 API 获取元数据与正文文本，不触碰 PDF 流，不请求 PDF 端点、不跟随 PDF 重定向；任何工具结果中都不包含 PDF 字节或 PDF 下载链接。
2. **每个用户使用自己的免费 ADS API Token。** Token 通过插件设置页填写，存入 DSH 凭据存储（凭据引用 `SCIX_API_TOKEN`），不硬编码、不集中管理或共享，也不出现在明文配置、补丁 YAML、日志或工具结果中。
3. **尊重速率限制。** 插件强制本地请求队列：突发上限 **15 次/秒**，每日配额 **3000 次**——比官方“多数请求类型 5000 次/天”的政策更保守。实际限额以各端点响应头 `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` 为准（每日 UTC 午夜重置）。遇到 `429` 时指数退避重试（1 秒起、逐次加倍、指数等待上限 60 秒；最多重试 5 次、合计最多 6 次发送；`Retry-After` / `X-RateLimit-Reset` 指示更长等待时以其为准，不受 60 秒上限约束）；本地配额耗尽时直接拒绝并给出重试时间，不再发出请求；绝不以并发压测方式调用 API。
4. **引用导出必须确定性生成。** 作者、年份、DOI、bibcode 等字段由 API 返回数据直接映射；导出文本由 ADS 导出端点服务端生成，插件原样透传，禁止由模型“回忆”或补全。

## 能力与诚实边界

以下为经确认的能力边界（公开 API 不具备的能力，插件如实说明，不夸大）：

1. **`search`：双路融合检索，非向量语义检索。** 公开 SciX/ADS API 没有向量/嵌入端点。本插件采用 Solr 词法检索 + `similar()` 文本相似度（MoreLikeThis 式摘要文本相似度）双路，以 Reciprocal Rank Fusion（RRF，k=60）融合排序。支持自然语言查询与结构化过滤：年份范围（`year_min`/`year_max`）、arXiv 分类（`arxiv_class`）、文献类型（`doctype`）、第一作者（`first_author`）与 UAT（统一天文学词表）概念（`uat`，词表标签或数字 id）均为独立可选参数；`query` 中也接受 Solr 字段语法。
2. **`read_paper`：仅对 arXiv 论文提供纯文本。** 对带 arXiv 标识符的论文，经 arXiv 官方 HTML（`arxiv.org/html/{id}`）或 ar5iv（`ar5iv.labs.arxiv.org/html/{id}`）获取纯文本并按章节解析；绝不触碰 PDF，也不落盘缓存。其他论文（或 arXiv HTML 渲染不可用时）显式返回 `body_available: false` 并给出摘要，绝不静默跳过或编造正文。背景：公开 ADS API 的 `body` 字段可搜索但不可返回，且不存在公开全文端点。
3. **`forward_citations`：施引列表来自 ADS，意图标注尽力而为。** ADS/SciX 本身没有引用意图字段。意图标注来自 Semantic Scholar 公开 API——仅传递 DOI/arXiv 标识符，绝不传递全文——使用其真实分类 `background` / `method` / `result_comparison`，并显式标明数据来源（`intent_source: "semantic-scholar"`）；无数据时 `intents: null`（S2 限流/出错/未匹配时同样降级为 `intents: null` 并附显式降级说明，绝不静默）。support/extend/contrast 之类的标签不存在于任何 API，本插件绝不编造。Semantic Scholar 未认证请求共享限流池，因此意图标注是尽力而为的补充，覆盖率有限。
4. **`find_gaps`：客户端启发式分析。** 基于会话工作集，通过公开 API 拉取施引/参考文献，按 UAT/关键词/年份等分组排序，输出启发式缺口候选。这不是私有语料库上的 PageRank/Leiden 社区分析（那需要自建数据库，公开 API 不提供）。

插件不绕过 ADS API 直接抓取出版商页面，不生成“看似有出处”但未经 API 验证的引用条目，也不把全文内容发送到 ADS/SciX 与你显式配置的模型提供商之外的第三方服务（Semantic Scholar 仅接收标识符）。

**会话工作集**：内存态、按会话隔离，默认集合 `ws-default`；`search` 命中自动加入工作集，`find_gaps` 与引用分析可限定在工作集内。插件卸载时工作集清空。

## 工具一览

8 个工具的名称与参数 schema 为稳定契约（见 [src/contracts/README.md](src/contracts/README.md)），参数命名精确，不提供别名。完整参数约束与输出字段见 [src/tools/PARAMS.md](src/tools/PARAMS.md)。

| 工具 | 用途 | 参数 | 返回要点 |
| --- | --- | --- | --- |
| `search` | 混合融合检索 | `query`（string，必填）；`year_min`/`year_max`（integer）；`arxiv_class`（string）；`doctype`（string，22 种 ADS 文献类型之一）；`first_author`（string）；`uat`（string，词表标签或数字 id）；`limit`（integer，1..100，默认 10） | 文献列表：bibcode、标题、作者、年份、被引数、摘要片段（≤500 字符，截断显式标记）；RRF 融合排序（`ranking: "rrf-fusion"`，非向量语义）；命中自动进入会话工作集 |
| `get_paper` | 单篇完整元数据 | `bibcode`（string，必填） | 全字段元数据、引用数、`body_available`（信号估计，仅 `read_paper` 确证） |
| `read_paper` | 读取正文纯文本 | `bibcode`（string，必填）；`section`（string，可选：章节标题模糊匹配、HTML id 如 `S2`/`S2.SS1`，或 `abstract`；缺省读全文） | 指定章节或全文纯文本（arXiv HTML/ar5iv），≤50000 字符并带 `truncated` 标记；不可得时 `body_available: false` + 摘要 |
| `citation_traverse` | 引用链遍历 | `bibcode`（string，必填）；`direction`（必填：`backward`/`forward`）；`mode`（`graph`/`chain`，默认 `graph`） | 关联文献列表及关系类型（`backward`=参考文献，`forward`=施引文献）；graph 单跳 ≤100 条，chain 深度 ≤2，截断显式标记 |
| `forward_citations` | 施引文献 + 意图 | `bibcode`（string，必填） | 施引列表（ADS，≤100 条）+ 尽力而为的意图标注（Semantic Scholar 真实分类，`intent_source` 标明来源；无数据时 `intents: null` 并附降级说明） |
| `find_gaps` | 工作集缺口分析 | `working_set_id`（string，必填；`ws-default` 为会话默认集） | 启发式缺口候选（`method: "client-side-heuristic"`）：时间/主题/作者维度的欠研究连接点 |
| `export_citation` | 确定性引用导出 | `bibcodes`（string 数组，必填，1..2000，精确去重、保持顺序）；`format`（必填：`bibtex`/`aastex`/`ris`） | 书目文本（string），API 导出端点原样输出 |
| `manage_library` | 个人文库操作 | `action`（必填：`list`/`create`/`get`/`update`/`delete`/`add_documents`/`remove_documents`）；`library_id`（string，get/update/delete/add/remove 必填）；`bibcodes`（string 数组，add/remove 必填，create 可选种子）；`name`（string，create 必填）；`description`（string，可选）；`public`（boolean，可选，create 默认 false） | 文库操作结果；add/remove 返回 `number_added`/`number_removed` 与 `invalid_bibcodes`（原样） |

**返回约定（所有工具必须遵守）：**

- bibcode、DOI、arXiv id、文库 id 等标识符逐字节来自 API 原始响应，不做模型侧改写、修剪或“回忆”。
- 描述论文的结果一律携带显式布尔值 `body_available`；正文不可得时明确说明。
- 任何结果不包含 PDF 字节或 PDF 下载链接。
- 省略/截断显式标记（如 `truncated: true`、`total_count`）。
- 未配置 Token 时返回可操作的提示（错误码 `TOKEN_MISSING`，指引前往设置页并附免费 Token 获取地址），而非未捕获异常。

## 安装

### 版本要求

- DSH 版本范围：`engines.dsh: ">=0.2.0 <0.3.0"`（预发布版本参与范围匹配）；开发与验证环境为 DSH **0.2.2-rc.5**。
- 插件版本：0.1.0。安装会在任何下载/链接动作之前先做版本兼容检查，不兼容直接拒绝。
- 本包未发布到 npm（`private: true`），请通过本地目录或 Git 仓库安装。

### 方式一：DSH 本地安装（推荐）

在 DSH 会话中让代理调用 `plugin_manager`，`action: install_bundle`，`target` 为仓库根目录（含 `package.json` 与 `cordis.patch.yml` 的目录）的**绝对路径**：

```json
{ "action": "install_bundle", "target": "/absolute/path/to/scix-dsh-plugin", "enabled": true }
```

- 本地安装会把该目录**链接**（pnpm link）进当前 profile 并注册为 bundle；变更影响该 profile 的所有会话，重启后保留。`enabled: true` 表示安装即启用。
- GUI 等价操作：**Plugins → Add plugin**，粘贴同一绝对路径。
- Desktop profile 由应用自带的包管理器完成安装，无需系统 pnpm。
- 迭代开发：就地修改文件后，配置变更经 HMR 热重载；整体替换已安装包需先 `remove_bundle` 再 `install_bundle`，并重启以加载新的 JS 模块。
- 不要手工改写 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录里手动运行 pnpm——`install_bundle` 会完成这些步骤。
- `plugin_manager` 操作需要会话具备相应文件访问权限（danger-full-access）或逐次批准。

### 方式二：从 GitHub 安装

```bash
git clone https://github.com/syfu95/scix-dsh-plugin.git
```

然后按方式一，以克隆所得目录的绝对路径作为 `target` 执行 `install_bundle`。

## 配置 API Token

1. **获取免费 Token。** ADS：<https://ui.adsabs.harvard.edu/#user/settings/token>；SciX：<https://scixplorer.org/user/settings/token>。SciX 与 ADS 使用同一套 API；同一 Token 在两个主机是否通用，以插件验证结果为准。
2. **在插件设置页填写。** DSH **Plugins** 页 → `scix-dsh-plugin` → **Configure**，在 Token 输入框粘贴个人 Token，点击**保存**。
3. **验证。** 点击 **Verify**：插件向所配置的 API 地址发送一次轻量认证查询（`search/query?q=*:*&rows=1&fl=id`），按 HTTP 状态报告结果（200=有效；401=Token 无效或缺失；429=限流）。验证过程绝不回显 Token。

**存储与安全**：Token 存入 DSH 凭据存储（凭据引用 `SCIX_API_TOKEN`），而非明文配置；任何读路径都不返回密钥，不写入日志或工具结果。轮换 Token 后下一次请求即生效，无需重启插件。未配置 Token 时，工具调用返回可操作提示，指引前往设置页填写。

**非机密配置项**（同一设置页）：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `apiBaseUrl` | `https://api.adsabs.harvard.edu/v1` | API 根地址；可改为 `https://api.scixplorer.org/v1`（SciX 主机） |
| `requestTimeoutMs` | `30000` | 单请求超时（毫秒） |

## 验收标准

以下清单来自 [Agent.md](Agent.md) §6，原样列出：

- [ ] 在 DSH 中配置有效 Token 后，`search("JWST NIRSpec exoplanet atmosphere", limit=10)` 返回 10 条以内真实文献，且每条包含可验证的 bibcode。
- [ ] 对一篇有正文的论文调用 `read_paper`，返回的文本内容非空，且不包含 PDF 二进制或下载链接。
- [ ] 对某篇论文调用 `citation_traverse(direction="forward")`，返回的施引文献数量与 ADS 网页端同一 bibcode 的引用数一致（允许 API 缓存延迟）。
- [ ] `export_citation(bibcodes, format="bibtex")` 输出的条目，抽查 3 条，作者、年份、DOI 与 ADS 页面完全一致。
- [ ] 连续快速触发 20 次 `search`，插件不返回 `429` 未处理错误，最终所有请求完成或给出明确的退避提示。
- [ ] 卸载插件后，DSH 会话中不再出现该插件的工具注册项。

**验证说明**：前 5 项需用户配置真实有效的 ADS Token 后在真实 API 上验证；第 6 项（卸载后工具注册消失）无需 Token 即可验证。第 2 项请选择带有 HTML/ar5iv 渲染的 arXiv 论文（见“能力与诚实边界”）；`body_available` 按篇探测，绝不假定。

## 开发与测试

- **零运行时依赖**：`package.json` 不声明 `dependencies`；`@deepseek-ai/*` 仅作为 `peerDependencies` 声明，运行时由 DSH 安装提供。
- **纯 ESM**（`"type": "module"`）。
- **单元测试**：`node --test`，测试文件位于 `test/core/` 与 `test/tools/`（`*.test.js`），仅使用 `node:test` + `node:assert`，无外部测试依赖；系统 Node.js ≥ 22 即可运行。
- **Mock fetch**：测试绝不请求真实 ADS API——以 stub 替换 `globalThis.fetch`，断言队列/退避/配额行为、标识符原样、显式 `body_available` 与确定性导出。
- **语法门**：每个 JS 文件须通过 `node --check <file>`。
- `src/contracts/**` 与纯助手模块保持零依赖，可被普通 Node 直接导入；引用 `@deepseek-ai/*` 的模块只在 DSH 运行时内加载。

## 许可

[MIT](LICENSE) © 2026 syfu95
