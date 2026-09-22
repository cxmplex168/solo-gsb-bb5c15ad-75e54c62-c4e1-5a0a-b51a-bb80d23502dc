# http-cache-lab

一个用于**演练 HTTP 缓存策略**的 API 服务。你可以：

- 预置带 `Cache-Control`、`ETag`、`Vary` 与**存入时间**的模拟响应；
- 携带**虚拟时间**发起请求，观察缓存按 `fresh` / `stale-while-revalidate` / `expired` 的判定；
- 观察并发请求命中同一需回源键时的**单飞回源令牌**（single-flight token）编排；
- 通过 `POST /admin/invalidate` 做**条件失效**：按方法、URL、请求头精确解析 Vary 变体，ETag 守卫，支持 `dryRun` 预览，事务内同时释放该键 pending 令牌；
- 逐步核对每次判定输出的**解释轨迹**（trail）；
- 一键重置整个演练状态。

技术栈：TypeScript · Fastify 4 · better-sqlite3（同步驱动，天然避免回源竞态）。

---

## 快速开始

```bash
docker compose up --build
```

服务在 **http://localhost:8080** 启动，SQLite 数据存放在命名卷 `cache-lab-data` 中。

```bash
curl -s http://localhost:8080/healthz
# {"ok":true,"stats":{"entries":0,"pendingTokens":0,"decisions":0}}
```

停止并清空数据卷：

```bash
docker compose down -v
```

在一次性容器里跑完整端到端示例（内存库，80 项断言，跑完即退出，不触碰数据卷）：

```bash
docker compose --profile smoke run --build --rm smoke
```

### 不用 Docker（本地开发）

```bash
npm ci
npm run build
DB_PATH=./data/lab.db npm start          # 生产模式
DB_PATH=:memory: npm run dev             # 开发模式（内存库）
npm run smoke                            # 80 项端到端断言
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `/data/cache-lab.db` | SQLite 文件路径，`:memory:` 为内存库 |
| `LOG_LEVEL` | `info` | pino 日志级别，演练时建议 `error` |

---

## 30 秒上手

```bash
T0=1767225600000   # 2026-01-01T00:00:00Z，毫秒时间戳

# 1) 预置一个 max-age=60、SWR=30 的响应
curl -s -X POST localhost:8080/admin/entries \
  -H 'content-type: application/json' -d '{
    "url": "https://api.example.test/feed",
    "status": 200,
    "responseHeaders": {
      "cache-control": "max-age=60, stale-while-revalidate=30",
      "etag": "\"v1\""
    },
    "body": "{\"v\":1}",
    "storedAt": '$T0'
  }'

# 2) t+5s：fresh，直接服务
curl -s -X POST localhost:8080/cache/request \
  -H 'content-type: application/json' -d '{
    "url": "https://api.example.test/feed",
    "virtualTime": '$((T0+5000))'
  }'

# 3) t+75s：处于 SWR 窗口，旧响应照常返回，同时签发回源令牌
curl -s -X POST localhost:8080/cache/request \
  -H 'content-type: application/json' -d '{
    "url": "https://api.example.test/feed",
    "virtualTime": '$((T0+75000))'
  }'
```

第 3 步响应的关键字段：

```json
{
  "state": "stale-while-revalidate",
  "action": "served-stale-and-revalidate",
  "servedStale": true,
  "response": { "status": 200, "headers": { "age": "75", "warning": "110 http-cache-lab \"Response is stale\"" }, "body": "{\"v\":1}" },
  "token": {
    "token": "TWW1WGYUPd…",
    "leader": true,
    "conditionalRequest": { "if-none-match": "\"v1\"" },
    "submitEndpoint": "POST /cache/revalidate"
  },
  "numbers": { "ageMs": 75000, "lifetimeMs": 60000, "swrMs": 30000, "freshnessMs": -15000 },
  "trail": [ /* 逐步解释，见下文 */ ]
}
```

领队拿着令牌去「回源」并提交结果：

```bash
curl -s -X POST localhost:8080/cache/revalidate \
  -H 'content-type: application/json' -d '{
    "token": "TWW1WGYUPd…",
    "status": 200,
    "headers": { "cache-control": "max-age=60, stale-while-revalidate=30", "etag": "\"v2\"" },
    "body": "{\"v\":2}",
    "originTime": '$((T0+75000))'
  }'
```

或者模拟源站确认未修改（304，自动合并响应头、沿用旧 body）：

```bash
curl -s -X POST localhost:8080/cache/revalidate \
  -H 'content-type: application/json' -d '{
    "token": "TWW1WGYUPd…", "status": 304,
    "headers": { "cache-control": "max-age=120", "etag": "\"v2\"" },
    "originTime": '$((T0+75000))'
  }'
```

---

## 缓存模型

### 虚拟时间

所有判定都使用请求显式携带的时间，与墙上时钟无关：

- body 字段 `virtualTime` / `storedAt` / `originTime`：整数毫秒或任何 `Date.parse` 能解析的字符串（ISO、HTTP 日期均可）；
- 也可用请求头 `X-Virtual-Time` 代替 body 字段。

`Age = max(0, virtualTime − storedAt)`，全程毫秒计算，输出 `Age` 头时向下取整。

### 缓存键

对以下材料逐行拼接后取 **SHA-256**，完整材料会随 `cacheKeyDetails.keyMaterial` 返回，可自行复核：

```
METHOD:<大写方法>
URL:<规范化 URL>
VARY:<逗号连接的小写 Vary 字段名>
H:<字段名>:<请求值，缺失为 ∅>
…
END
```

URL 规范化规则：scheme/host 小写、去除默认端口、路径 percent-encoding 归一、query 解析为 `(name,value)` 后字典序重排、丢弃 fragment。`/a` 与 `/a/` 视为不同资源。

Vary 变体查找：先按「方法 + 规范化 URL」筛候选条目，再用候选响应自己的 `Vary` 字段结合本次请求头算键精确匹配——这与真实缓存「响应头决定键」的行为一致。`Vary: *` 不可枚举，预置时直接拒绝（400）。

### 状态机

| state | 含义 | 是否返回响应 | 令牌 |
| --- | --- | --- | --- |
| `fresh` | `age + min-fresh ≤ lifetime` | ✅ 缓存响应 | 无 |
| `stale-while-revalidate` | 落在 `lifetime ~ lifetime+swr` 窗口 | ✅ 旧响应（带 `Warning: 110`） | ✅ 领队/加入 |
| `stale` | 陈旧但被请求显式接受（`max-stale`、`only-if-cached`） | ✅ 旧响应 | 通常无 |
| `expired` | 过期且不可陈旧服务 | ❌ | ✅ 同步回源 |
| `miss` | 无缓存条目 | ❌ | ✅ 回源 |
| `bypass` | 请求 `no-store` / 非 GET·HEAD 方法 | ❌ | ✅ 回源（不读缓存） |
| `gateway-timeout` | `only-if-cached` 且无可用副本 | ❌（504 语义） | 无 |

新鲜寿命优先级：`s-maxage` > `max-age` > `Expires - storedAt` > 启发式 `10% × (storedAt - Last-Modified)` > `0`。

强制再验证开关：响应 `no-cache`、`must-revalidate`、`proxy-revalidate`，以及请求 `max-age` 被 Age 超过时，**禁止任何陈旧服务**（SWR 也不行）。请求侧还支持 `min-fresh`、`max-stale[=Δ]`、`only-if-cached`、`no-store`。响应侧另解析 `stale-if-error`（仅记录，因本服务不自动回源）。

### 单飞回源令牌

当判定需要回源时，服务在一个 SQLite `IMMEDIATE` 事务内：

1. 查该缓存键是否已有 `pending` 令牌；
2. **没有** → 生成 32 字节随机令牌，当前请求为 **leader**：
   - SWR：`action=served-stale-and-revalidate`（旧响应 + 令牌）；
   - miss/expired：`action=must-revalidate`（无响应，客户端必须提交回源结果）；
3. **已有** → 当前请求为加入者：
   - SWR：`action=served-stale-joining-revalidation`（旧响应 + 同一个令牌）；
   - miss/expired：`action=waiting`（**等待状态**，无响应、不重复回源）。

令牌行同时记录 method / 规范化 URL / Vary / 旧 ETag；响应里附 `conditionalRequest`（如 `If-None-Match`）供演练条件请求。

提交回源结果（`POST /cache/revalidate`）：

- 令牌不存在 → **404**；
- 令牌已结束且提交内容的指纹与首次相同 → **200 + `idempotentReplay: true`**（幂等重放）；
- 令牌已结束但内容不同 → **409**（拒绝覆盖）；
- 令牌 pending → 原子地写入新响应并把令牌置为 `consumed`；
- 提交 `status: 304` → 按 RFC 9111 合并：新响应头逐头覆盖旧头，body 与状态码沿用旧响应，`storedAt` 更新为 `originTime`；
- 回源响应的 `Vary` 集合与缓存键不一致 → **409**（演练要求变体结构稳定）。

等待方在领队提交后，**重新发起** `/cache/request`（带新的虚拟时间）即可看到新响应。令牌可由领队显式放弃（`POST /cache/tokens/:token/release`），也会在该键被 `POST /admin/invalidate` 条件失效时随删除事务一并释放——两种方式释放后，同键才能签发新令牌。

### 解释轨迹（trail）

每次 `/cache/request` 的响应都包含 `trail: [{step, detail, data?}]`，按执行顺序覆盖：

`request` → `normalize` → `variants?` → `key` → `lookup` → `request-cache-control?` → `response-cache-control?` → `no-store?` → `age` → `lifetime` → `min-fresh?` / `max-stale?` / `no-cache?` / `must-revalidate?` → `freshness` → `stale-while-revalidate?` / `max-stale-serve?` / `expired` → `token?`

每步都给出人话解释与可核对的数值（`numbers`）。所有判定同时落库到 `decision_logs`，可通过 `GET /cache/decisions` 回看。

---

## API 参考

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/cache/request` | 携带虚拟时间发起缓存请求（核心端点） |
| `POST` | `/cache/revalidate` | 凭令牌提交回源结果（幂等） |
| `POST` | `/cache/tokens/:token/release` | 放弃 pending 令牌 |
| `GET` | `/cache/tokens?all=0` | 令牌列表（默认仅 pending） |
| `GET` | `/cache/entries?limit=100` | 预置/回源后的缓存条目 |
| `GET` | `/cache/decisions?limit=100` | 历史判定（含完整 trail） |
| `GET` | `/cache/stats` | entries / pendingTokens / decisions 计数 |
| `POST` | `/admin/entries` | 预置模拟响应 |
| `DELETE` | `/admin/entries/:cacheKey` | 删除单个条目 |
| `POST` | `/admin/invalidate` | 条件失效：方法 + URL + Vary 请求头精确定位，ETag 守卫，支持 `dryRun` |
| `GET` | `/admin/invalidations?limit=100` | 条件失效审计记录（含 dryRun 预览记录） |
| `POST` | `/admin/reset` | 清空全部数据并轮换实例 ID |
| `GET` | `/healthz` | 健康检查 |

### `POST /cache/request`

```json
{
  "method": "GET",
  "url": "https://api.example.test/a?b=2&a=1#frag",
  "headers": { "accept-encoding": "gzip", "cache-control": "max-stale=10" },
  "virtualTime": "2026-01-01T00:01:15Z",
  "requestId": "my-trace-id"
}
```

- `method` 默认 `GET`；仅 `GET`/`HEAD` 读取缓存（其余方法走 `bypass`）。
- 头名大小写不敏感；数组值按 `, ` 合并。
- `HEAD` 命中时抑制 body（`bodySuppressedForHead: true`）。
- `requestId` 缺省时自动生成，便于串联并发组。

### `POST /admin/entries`

```json
{
  "method": "GET",
  "url": "https://api.example.test/v",
  "requestHeaders": { "accept-encoding": "br" },
  "status": 200,
  "responseHeaders": { "cache-control": "max-age=60", "vary": "Accept-Encoding" },
  "body": "...",
  "storedAt": 1767225600000
}
```

便捷字段（可选，会并入响应头）：`cacheControl`、`etag`（自动补引号）、`vary`。
`date` / `expires` / `last-modified` 接受 ISO 字符串，入库时统一为 IMF-fixdate；缺省 `Date` 自动补为 `storedAt`。
同一缓存键重复预置即为覆盖（保留 `createdAt`，刷新 `updatedAt`）。

### `POST /cache/revalidate`

```json
{
  "token": "…",
  "status": 200,
  "headers": { "cache-control": "max-age=60" },
  "body": "…",
  "originTime": 1767225675000
}
```

`responseHeaders` 与 `headers` 二者皆可（后者优先）；`body` 为字符串或 `null`。

### `POST /admin/invalidate`

按「方法 + 规范化 URL + 请求头」**精确解析 Vary 变体**后做条件失效：

```json
{
  "method": "GET",
  "url": "https://api.example.test/v?b=2&a=1",
  "headers": { "accept-encoding": "br" },
  "expectedEtag": "\"v2\"",
  "dryRun": false,
  "reason": "deploy-2026-01-02",
  "requestId": "purge-job-42"
}
```

- `method` 默认 `GET`；`HEAD` 与缓存请求一样映射到 `GET` 存储键（响应中以 `target.keyMethod` 体现）。
- `headers` / `requestHeaders` 二者皆可，仅用于按各候选响应自身的 `Vary` 字段选择变体；URL 与键都按与普通请求完全相同的规则规范化。
- `expectedEtag`（别名 `etag`）可选：**仅当目标条目的 ETag 与之逐字节相等时才删除**；裸值（`v2`）自动补双引号，`W/"…"` 弱校验值原样保留。条目不携带 ETag 时视为守卫失败。
- `dryRun: true` 只解析与判定，不删条目、不动令牌；审计记录照常写入（`dryRun=true`），可事后追溯预览了什么。
- `reason` / `requestId` 可选，便于把失效操作与发布单、作业 ID 串联。

定位规则（与真实缓存「响应头决定键」一致）：

1. 先按「方法 + 规范化 URL」筛候选条目；
2. 用每个候选响应自己的 `Vary` 结合本次请求头算键——只有键哈希完全相等的**唯一一个**变体可能成为目标；
3. 其他 Vary 变体进入 `skipped`，原因 `variant-not-selected`；
4. 目标变体存在但 ETag 不符 → 进入 `skipped`，原因 `etag-mismatch`，**绝不删除任何条目**；
5. 守卫通过 → 在单个 SQLite `IMMEDIATE` 事务内删除该条目，并把该键上的 **pending 回源令牌置为 `released`**（否则同键无法签发新令牌）。

响应：

```json
{
  "requestId": "inv_a1b2c3d4…",
  "recordId": 7,
  "dryRun": false,
  "outcome": "invalidated",
  "target": { "method": "GET", "normalizedUrl": "https://api.example.test/v?a=1&b=2", "requestHeaders": { "accept-encoding": "br" }, "expectedEtag": "\"v2\"" },
  "affected": [
    { "cacheKey": "9f8c…", "method": "GET", "normalizedUrl": "…", "etag": "\"v2\"",
      "vary": ["accept-encoding"], "varySelectors": [{ "name": "accept-encoding", "value": "br" }],
      "disposition": "deleted" }
  ],
  "skipped": [
    { "cacheKey": "31aa…", "etag": "\"v2-gzip\"", "reason": "variant-not-selected", "detail": "该条目的 Vary(accept-encoding) 选择值对应另一个变体…" }
  ],
  "releasedTokens": [
    { "token": "TWW1WGYUPd…", "tokenPrefix": "TWW1WGYUPd…", "etag": "\"v2\"", "disposition": "released" }
  ],
  "counts": { "deletedEntries": 1, "releasedTokens": 1 },
  "recordEndpoint": "GET /admin/invalidations"
}
```

- `outcome`：`invalidated`（正式删除）/ `preview`（dryRun 有待删项）/ `noop`（没有符合条件的条目，HTTP 状态仍为 200）。
- dryRun 下 `disposition` 为 `would-delete` / `would-release`，`counts` 恒为 0。
- `GET /admin/invalidations` 返回全部审计记录（最近在前），含定位材料、受影响键、跳过原因、释放的完整令牌值与墙上时间。

快速演练（承接「30 秒上手」中的条目）：

```bash
# 先预览：确认会删哪个变体、会释放哪个令牌，不改动数据
curl -s -X POST localhost:8080/admin/invalidate \
  -H 'content-type: application/json' -d '{
    "url": "https://api.example.test/feed",
    "expectedEtag": "\"v1\"",
    "dryRun": true
  }'

# 正式执行：ETag 相符才删，并释放该键 pending 回源令牌
curl -s -X POST localhost:8080/admin/invalidate \
  -H 'content-type: application/json' -d '{
    "url": "https://api.example.test/feed",
    "expectedEtag": "\"v1\"",
    "reason": "hotfix-feed"
  }'

# 回看失效记录（dryRun 预览也在其中）
curl -s 'localhost:8080/admin/invalidations?limit=20'
```

---

## 演练剧本建议

1. **新鲜度三态**：同一预置条目，用 `t+30s / t+75s / t+200s` 三个虚拟时间请求，观察 `fresh → SWR → expired`。
2. **并发单飞**：expired 状态下并发 5 个请求，确认只有 1 个 `must-revalidate`、其余 `waiting` 且共享同一令牌；领队提交后其余请求重放命中新响应。
3. **幂等与防覆盖**：用同一令牌提交两次相同内容（第二次 `idempotentReplay=true`），再改一个字节提交（409）。
4. **304 合并**：预置 `no-cache` + ETag 条目 → 拿到带 `If-None-Match` 的令牌 → 提交 304 与新 `max-age` → 验证 body 沿用、寿命更新。
5. **Vary 变体**：预置同一 URL 的 `gzip` / `br` 两个变体，换请求头观察键材料与命中差异。
6. **URL 规范化**：用乱序 query、大小写 host、默认端口、fragment 等形式请求同一资源，对比 `normalizedUrl` 与 `cacheKey`。
7. **条件失效**：预置两个 Vary 变体后先 `dryRun` 预览（确认只选中一个变体），再用错误/正确的 `expectedEtag` 正式失效；在变体上制造一个 pending 回源令牌，观察失效事务同时释放令牌、之后同键请求能成为新领队；最后在 `/admin/invalidations` 核对审计记录。

---

## 设计说明与边界

- **单进程 SQLite**：回源单飞依赖 `better-sqlite3` 的同步事务（`BEGIN IMMEDIATE`）。多副本部署时每个实例各自单飞；本项目定位为单机演练工具。
- **不主动发起真实回源**：服务只模拟缓存层，「源站响应」由客户端通过令牌提交，时间线完全可控、可重放。
- **等待不阻塞连接**：`waiting` 是立即返回的状态对象而非长轮询，方便在脚本/测试中显式编排并发组。
- **Vary 结构稳定**：回源响应不得改变 `Vary` 字段集合（返回 409）；真实缓存中这等价于换键，需要重新填充。
- **不模拟的部分**：请求折叠时的 `Pragma`、`stale-if-error` 的自动 5xx 回退（仅轨迹提示）、共享/私有缓存授权语义（`private` 被解析但不拦截存储，便于自由演练）。

## 项目结构

```
src/
  index.ts          Fastify 启动与错误处理
  routes.ts         HTTP 端点与单飞编排
  freshness.ts      纯函数：新鲜度判定与轨迹生成
  canonical.ts      URL 规范化、Vary 解析、缓存键计算
  cache-control.ts  Cache-Control 指令解析（请求/响应共用）
  http-date.ts      IMF-fixdate / RFC850 / asctime 解析与格式化
  db.ts             SQLite 表、条目写入、原子令牌签发与提交、条件失效事务与审计
  util.ts           时间/头/指纹等工具
scripts/smoke.ts    端到端断言（80 项）
```
