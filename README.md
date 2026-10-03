# 事故处置情境编排与演练（本地 Web 应用）

供**培训师**编排事故处置情境、供**学员**按现场状态进行处置选择的本地 Web 应用。

- 技术栈：Node.js + Express + SQLite（`better-sqlite3`）+ 原生浏览器界面（无需前端构建）
- 培训师定义：至多 **8 个布尔现场状态**、**情境节点**、带**状态条件 / 状态变更**的**选项**，并指定**起点**与**结局**
- 学员视角：展示当前情境描述、**可选项**、当前**现场状态**与**走过的路径**
- 发布前自动从初态枚举所有可达的（节点 × 状态组合）：
  - 非结局节点**不能无路可走**；
  - **不能存在可无限循环而不抵达结局的路径**；
  - 不满足则给出**可复现路径**（含每一步的状态快照，以及具体的循环段）并**拒绝发布**。
- 每次发布**冻结完整内容**为新版本：进行中的会话继续沿原版本完成，新会话使用最新版
- 每步选择必须携带**当前步号**；步号过期/重复、条件不满足、选项不存在等情况一律返回**原因和现状**，且不推进会话
- 培训师可凭**源会话码、分歧步号、所见的源当前步号**，从历史局面创建**可继续选择的分支**（复盘分叉）；分支沿用冻结版本，已结束会话也可从此前的非结局步分叉，支持再次分叉与路径对照
- 草稿中的**无效引用**（不存在的状态/目标节点）与**矛盾条件**（同一状态同时要求是和否）在保存时即被拒绝

---

## 一、一键启动（Docker Compose，推荐）

前置要求：已安装 Docker 与 Docker Compose 插件。

```bash
cd <本项目目录>
docker compose up -d --build
```

启动后访问：

> **http://localhost:8080**

健康检查地址：<http://localhost:8080/api/health>

停止 / 查看日志：

```bash
docker compose down          # 停止
docker compose logs -f       # 跟踪日志
docker compose up -d --build # 重新构建并启动
```

首次启动会自动：

1. 在 `./data/app.db` 创建 SQLite 数据库与全部表结构；
2. 写入一个**已发布的内置示例情境**「车间可燃气体泄漏初期处置」，可直接用于体验学员演练流程。

数据持久化在宿主机 `./data` 目录，删除容器不会丢数据；备份该目录即可备份全部情境与会话。

### 修改访问端口

默认占用宿主机 **8080**。改用其它端口（例如 9000）有两种方式：

```bash
# 方式一：临时环境变量
APP_PORT=9000 docker compose up -d

# 方式二：在项目根目录新建 .env 文件，写入
# APP_PORT=9000
```

随后访问 <http://localhost:9000>。

---

## 二、本地 Node 直接启动（不使用 Docker）

要求 Node.js ≥ 20（`better-sqlite3` 会在 `npm install` 时本地编译，需要 python3 / make / g++ 工具链）。

```bash
npm install
npm start
```

访问 **http://localhost:8080**。

---

## 三、配置项

| 配置 / 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口 |
| `DB_PATH` | Docker 内 `/app/data/app.db`；本地运行时 `./data/app.db` | SQLite 数据库文件路径，所在目录会自动创建 |
| `APP_PORT`（仅 Compose） | `8080` | 宿主机映射端口，改它即可，无需改 Dockerfile |
| `TZ` | `Asia/Shanghai` | 容器时区（影响时间显示） |

数据库表：`scenarios`（情境及草稿）、`versions`（每次发布冻结的完整内容）、`sessions`（学员会话：步号、状态位掩码、已走路径、绑定版本；分支另用 `parent_code`/`fork_step_no` 记录来源会话与分歧步）。

---

## 四、使用说明

### 培训师（页面顶部“培训师编排”页）

1. **新建情境**：系统生成一个可直接编辑的最小模板。
2. 右侧维护**现场状态**（1–8 个布尔量，各自指定初始值）。
3. 中间维护**节点**：标题、情境描述；勾选“结局节点”标记结局；在顶部“起点”下拉中指定起点（至少一个结局）。
4. 非结局节点下添加**选项**：
   - **显示条件**：列出对状态的“要求为是/否”，全部满足时该选项才可选；
   - **状态变更**：选择后把若干状态“置为是/否”；
   - **跳转**：选择后进入的目标节点。
5. 常用操作：
   - **保存草稿**：先做结构校验（无效引用、矛盾条件等直接拒绝，不写库），同时返回一份发布预检报告；
   - **发布前检查**：只检查不保存，查看死路/无限循环的可复现路径；
   - **发布新版本**：完整检查通过后，把当前草稿冻结为 `v+1`。已有进行中的会话不受影响，新会话走新版本。
6. 删除仍被选项条件/变更引用的状态时，界面会拦截并提示引用位置。

### 学员（“学员演练”页）

1. 在“可演练情境”中选择已发布情境，可填写姓名后**开始新演练**（自动绑定最新发布版）；
2. 阅读当前情境，在右侧查看**现场状态**，从卡片中选择处置动作；
3. 条件不满足的选项会以 🔒 灰显并说明缺哪个条件；即使强行提交，服务端也会拒绝并返回原因与现状；
4. 右侧“已走路径”逐步记录：第几步、在哪个节点、选了什么、到达哪里、当时状态；
5. 可凭 **10 位会话码** 或下方列表随时“继续”未完成的演练；到达结局后会话结束。

### 培训师复盘：从历史步分叉（🌿）

复盘演练时，可在**学员会话页右侧“培训师复盘：从历史步分叉”**卡片（或在“已走路径”任一行点“🌿 从此分叉”）创建分支：

1. 填写**分歧步号**（第 0 步为该冻结版本的初态；取值范围 0 ～ 源会话当前步号），并提交创建时所见的**源当前步号**（页面自动携带）；
2. 分支沿用**源会话绑定的冻结版本**，保留到达分歧步现场之前已完成的**路径与该步现场状态**，从该步起可重新选择；分支步号与源会话在分歧点保持一致，后续选择只推进分支；
3. **原会话与其它分支不受影响**；分支与普通会话使用同一套步号校验（`STEP_STALE` 等）与版本绑定规则；
4. **已结束会话**也可从此前的**非结局步**分叉；**结局步不得分叉**；
5. 分支**可以再次分叉**；会话页顶部绿色横幅展示分支**来源与分歧步**，点“查看分支对照”可看到根会话链、每次分叉的来源/分歧步，以及“共同路径 / 源会话后续 / 分支后续”的并排对照。

创建被拒绝时（不创建任何分支）会说明原因；能定位到源会话时同时返回其**当前步号**：

| 情形 | errorCode | HTTP |
| --- | --- | --- |
| 源会话步号已变化（所见步号过期） | `STEP_STALE`（附 `sourceCurrentStepNo`） | 409 |
| 分歧点越界（非整数 / <0 / >当前步号） | `FORK_STEP_OUT_OF_RANGE`（附 `sourceCurrentStepNo`） | 400 |
| 分歧步是结局步 | `FORK_AT_ENDING_STEP`（附 `sourceCurrentStepNo`） | 409 |
| 源会话不存在 | `SESSION_NOT_FOUND` | 404 |
| 源会话绑定版本缺失 | `VERSION_MISSING` | 500 |

---

## 五、发布检查规则（核心）

系统把每个可达局面表示为 `(节点, 状态组合)`，从 `(起点, 初始状态)` 出发做完整状态空间枚举（至多 8 个布尔状态，组合数 ≤ 256 × 节点数）：

1. **无路可走（死路）**：某个可达的非结局局面下没有任何条件满足的选项 → 拒绝发布，并给出从初态到该局面的逐步路径。
2. **可无限循环**：采用“安全局面”收缩判定 —— 结局是安全的；一个非结局局面，当且仅当它存在可选边**且所有**可选边都通向安全局面时才安全。收缩后仍不安全的可达局面即可能被学员无限走下去而永不抵达结局 → 拒绝发布，报告中给出：
   - 从初态到达该局面的**可复现路径**；
   - 从该局面出发的**具体循环段**（重复执行其中的选择即可永不抵达结局）。
3. **不可达节点**只作为警告，不阻止发布。

结构问题（独立于发布检查，**保存草稿时**即拒绝）：状态数量不在 1–8、id 非法/重复、标题为空、起点不存在、无结局、选项目标节点不存在、条件/变更引用不存在的状态、同一选项对同一状态同时要求“是”和“否”、结局节点携带选项等。

### 会话推进规则

每步请求必须带 `stepNo`（当前步号，从 0 开始）：

- `stepNo` 与服务端当前步号不一致（过期页面、重复提交、并发双击）→ `409 STEP_STALE`，返回现状，不推进；
- 条件不满足 → `409 CONDITION_NOT_MET`，逐条列出哪个状态需要是/否，返回现状，不推进；
- 选项不属于当前节点 → `400 OPTION_NOT_FOUND`；会话已结束 → `409 SESSION_ENDED`。

### 复盘分叉规则

分叉请求 `POST /api/sessions/:code/fork`，路径中的 `:code` 为**源会话码**，请求体：

- `divergenceStepNo`（必填，整数）：分歧步号。第 0 步 = 源会话绑定版本的初态（起点节点 + 初始状态，路径为空）；`k>0` 时取源会话“第 k 步选择完成后”记录的节点与现场状态，分支当前步号为 `k`，并保留源路径中第 1～k 步作为“沿流”路径；
- `sourceStepNo`（必填，整数）：**创建时所见的源当前步号**。服务端与源会话当前步号严格比对，不一致即 `409 STEP_STALE`（防止源会话已被推进后误用旧现场），响应体带 `sourceCurrentStepNo`，不创建；
- `traineeName`（可选）：分支学员名，缺省时沿用源会话学员名。

校验：源会话存在（`404 SESSION_NOT_FOUND`）、绑定版本存在（`500 VERSION_MISSING`）、分歧点在 `0..源当前步号` 内（`400 FORK_STEP_OUT_OF_RANGE`）、分歧步节点不是结局（`409 FORK_AT_ENDING_STEP`，已结束会话只能从此前非结局步分叉）。任何失败都**不创建分支**。

成功响应即新分支的会话现状快照（与 `GET /api/sessions/:code` 同构），并额外带：

- `branch.parentCode`：直接来源会话码；`branch.forkStepNo`：分歧步号；`branch.rootCode`：沿分叉链追溯到的根会话码；`branch.chain`：根→本会话的逐次分叉链；
- `note`：创建说明。

分支之后与普通会话完全一致：继续调用 `POST /api/sessions/:code/move`（携带分支自己的 `stepNo`）推进；分支可以再次作为源会话被分叉。

---

## 六、主要 HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/published` | 已发布情境列表（学员） |
| POST | `/api/sessions` | `{scenarioId, traineeName?}` 开始新会话（绑定最新版） |
| GET | `/api/sessions/:code` | 查询会话现状（可选项/状态/路径；分支附 `branch` 来源信息） |
| POST | `/api/sessions/:code/move` | `{optionId, stepNo}` 执行一步；失败返回原因与现状 |
| POST | `/api/sessions/:code/fork` | `{divergenceStepNo, sourceStepNo, traineeName?}` 从源会话的历史步分叉创建分支 |
| GET | `/api/sessions/:code/lineage` | 分支血缘与路径对照（根会话链、各次分叉的来源/分歧步及各自后续路径） |
| GET | `/api/sessions` | 最近会话列表（分支附 `parent_code`、`fork_step_no`） |
| GET | `/api/scenarios` | 培训师情境列表 |
| POST | `/api/scenarios` | 新建（首版草稿，结构校验） |
| GET | `/api/scenarios/:id` | 草稿 + 版本清单 |
| PUT | `/api/scenarios/:id/draft` | 保存草稿（无效引用/矛盾条件拒绝） |
| POST | `/api/scenarios/:id/analyze` | 发布前检查（可带未保存草稿） |
| POST | `/api/scenarios/:id/publish` | 发布冻结新版本（检查不过返回 422 与可复现路径） |

### 复盘分叉调用示例（curl）

```bash
BASE=http://localhost:8080
SRC=312961ff27   # 10 位源会话码（GET /api/sessions 可查）

# 1) 先查源会话现状，取得当前步号 stepNo（本例源会话已结束于第 3 步）
curl -s $BASE/api/sessions/$SRC | jq '{code, stepNo, status, node: .currentNode.title}'

# 2) 从源会话的第 2 步创建分支；sourceStepNo 必须等于上面看到的当前步号
curl -s -X POST $BASE/api/sessions/$SRC/fork \
  -H 'Content-Type: application/json' \
  -d '{"divergenceStepNo": 2, "sourceStepNo": 3, "traineeName": "复盘-王培训师"}' | jq \
  '{code, version, stepNo, node: .currentNode.title, inheritedPath: [.path[].step], branch}'

# 成功响应（节选）：
# {
#   "code": "f8ea17cc67", "version": 1, "stepNo": 2,
#   "node": "安全区建立指挥点",
#   "inheritedPath": [1, 2],
#   "branch": { "parentCode": "312961ff27", "forkStepNo": 2, "rootCode": "312961ff27", "chain": [...] }
# }

# 3) 在分支上继续选择（stepNo 用分支自己的当前步号 2）
curl -s -X POST $BASE/api/sessions/f8ea17cc67/move \
  -H 'Content-Type: application/json' \
  -d '{"optionId": "o_report", "stepNo": 2}' | jq '{stepNo, node: .currentNode.title, status}'

# 4) 分支再次分叉 / 查看来源与路径对照
curl -s -X POST $BASE/api/sessions/f8ea17cc67/fork \
  -H 'Content-Type: application/json' -d '{"divergenceStepNo": 3, "sourceStepNo": 3}'
curl -s $BASE/api/sessions/f8ea17cc67/lineage | jq \
  '{root: .root.code, ancestry: [.ancestry[].code], forks: [.forks[] | {parent: .parent.code, at: .forkStepNo, branch: .branch.code, then: [.branch.path[].step]}]}'

# 失败示例：源会话已被推进、所见步号过期（不创建，返回源当前步号）
#   HTTP 409 {"errorCode":"STEP_STALE","sourceCurrentStepNo":4,...}
# 失败示例：分歧点是结局步
#   HTTP 409 {"errorCode":"FORK_AT_ENDING_STEP","sourceCurrentStepNo":3,...}
```

页面操作：打开任一会话 → 右侧“🌿 培训师复盘：从历史步分叉”卡片输入分歧步号 → “创建分支并进入”；或在“已走路径”某行点“🌿 从此分叉”，再点“查看分支对照”。

---

## 七、目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json / package-lock.json
├── server/
│   ├── server.js      # Express 路由（编排 / 发布 / 会话接口）
│   ├── db.js          # SQLite 连接、建表、id 生成
│   ├── scenario.js    # 草稿校验 + 状态空间可达性/死路/循环分析
│   ├── session.js     # 会话快照、“带步号的一步”推进规则、复盘分叉与分支血缘
│   └── seed.js        # 内置示例情境（首启写入）
├── public/
│   ├── index.html     # 单页界面（学员演练 / 培训师编排两个页签）
│   ├── styles.css
│   └── app.js
└── data/              # 运行后生成：SQLite 数据库（持久化卷）
```
