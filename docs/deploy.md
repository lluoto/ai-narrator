# 部署

日期：2026-08-13
形态：**单容器**。后端在同一端口托管前端构建产物，一个镜像、一个端口。

---

## 一、为什么是单容器

按可用性、迁移性、性能三条衡量，迁移性是决定项：

- **迁移性**：一个镜像一个端口，构建期不必把 API 地址烘进前端，也不需要配 CORS。换地方 `docker run` 就跑。前后端分开要两次发布、两处配置。
- **可用性**：一个故障域，运维面最小。分层的好处是 API 挂了前端还能出错误页，当前阶段不值这个复杂度。
- **性能**：产物很小（JS 123KB / gzip 43KB，CSS 29KB / gzip 5KB），CDN 边际收益有限。真实延迟在 LLM 那一侧（实测叙事回合 2–5 秒），不在静态资源。

静态托管在 `src/api/server.ts` 的 `serveStatic()`：

- 带内容哈希的资源（`index-XXXX.js`）发 `immutable, max-age=31536000`；`index.html` 发 `no-cache`，否则用户会一直拿到旧页面、里面引用着已不存在的资源名。
- API 路由优先匹配，静态兜底，接口不会被遮住。
- 带扩展名的路径未命中直接 404，**不回退 index.html**。回退会让前端拿到一份 HTML 却按 js/wav 去解析，报出来的错和真实原因毫无关系——预制语音那边踩过：vite dev 对缺失的 `.mp3` 回 200 + HTML。
- 没有构建产物时回落到服务端内置的调试页，本地开发不受影响。

---

## 二、干净克隆构建与可选的运行期世界模型

干净克隆可以直接构建：Dockerfile 不复制 `assets/`，`.dockerignore` 也排除它。镜像只创建空的、root-owned 的 `/app/assets`、`/app/world-model-policy` 和 `/app/cthulhu-dataset` 挂载点；世界模型不能被烘进镜像或由请求选择主机路径。

默认部署保持世界模型绑定关闭：

```bash
docker compose up -d --build
```

未提供 legacy assets 时，旧的世界模型功能只会警告并降级；服务和 liveness 不因其缺失而失败。需要 legacy assets 和已审核的 compiled Cthulhu 绑定时，使用显式 override，并提供三个宿主机绝对路径：

```bash
export WORLD_MODEL_ASSETS_DIR=/srv/trpg/legacy-assets
export COMPILED_CTHULHU_WORLD_MODEL_POLICY_HOST_PATH=/srv/trpg/policies/compiled-cthulhu-policy.json
export CTHULHU_DATASET_HOST_PATH=/srv/trpg/datasets/cthulhu
docker compose -f docker-compose.yml -f docker-compose.world-model.yml up -d --build
```

该 override 用 read-only bind mounts 将它们映射到固定容器路径；应用只收到这些固定路径：

| 变量 | fixed container path |
|---|---|
| `WORLD_MODEL_PATH` | `/app/assets/v18_all_master.jsonl` |
| `CTHULHU_MODEL_PATH` | `/app/assets/cthulhu_world_model.jsonl` |
| `COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH` | `/app/world-model-policy/compiled-cthulhu-world-model-policy.json` |
| `CTHULHU_DATASET_PATH` | `/app/cthulhu-dataset` |

Compiled policy and dataset remain an atomic pair: configuring only one is fail-closed at startup. The three host sources must grant container UID/GID 1000 read access and directory traversal; host-specific SELinux labels and bind-mount policy remain operator responsibilities. This workflow has only been statically contract-tested here; Docker/Linux image execution was not run in this environment. Legacy loading remains lazy, so a missing legacy mount degrades the legacy feature rather than blocking liveness.

## Player invitation delivery

The optional browser player façade needs a separate `COMPILER_PLAYER_DELIVERY_HMAC_SECRET`. Generate at least 32 random bytes and encode them as base64url (minimum 43 URL-safe characters); never reuse an operator/Keeper bearer token or put a real value in source control. `COMPILER_PLAYER_DELIVERY_ROOT` is durable private storage for digest-only claim acknowledgements. `COMPILER_PLAYER_DELIVERY_INVITE_TTL_SECONDS` and `COMPILER_PLAYER_DELIVERY_COOKIE_TTL_SECONDS` must each be whole seconds from 60 through 31536000.

When the secret is missing/invalid, or either explicitly configured TTL is invalid, the service deliberately creates owner-only compiled sessions and issues no player invitation. Omitted TTLs use the 900-second invite and 604800-second cookie defaults. Player cookies are `Secure`, `HttpOnly`, and `SameSite=Strict`, so production requires HTTPS on the same origin that serves `/play/:sessionId`; do not add credentialed CORS. Rotating the delivery HMAC secret invalidates all existing player cookies. This slice has no existing-session reissue endpoint: an already consumed invitation normally cannot recover after rotation unless the client still has the same invite and claim ID, so plan a replacement session/new delivery when rotating.

Set `COMPILER_PUBLIC_ORIGIN` to the exact browser-visible `https://host` origin whenever browser player delivery is enabled, including when TLS terminates at a trusted reverse proxy and the backend request URL is internal HTTP. It accepts only origin-only HTTPS URLs (no path, query, fragment, or userinfo) and normalizes the default HTTPS port; missing or invalid values disable player delivery. The service never trusts `X-Forwarded-*` headers.

---

## 三、跑起来

```bash
docker compose up -d --build
```

### Runtime environment validation

`PORT` is a plain decimal integer from 1 through 65535 (default `3099`).
`SESSION_TIMEOUT_MINUTES` is a plain positive decimal safe integer (default
`30`), and its conversion to milliseconds must also be safe. Invalid explicit
values fail server startup before inventory, timers, or listening begin; they
are not truncated or partially parsed. Compose forwards
`SESSION_TIMEOUT_MINUTES` with the same default.

Ordinary owner WebSocket admission is process-local: it counts both a pending
upgrade reservation and an open socket. `ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS`
(default `512`), `ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_SESSION`
(default `4`), and `ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_PRINCIPAL`
(default `32`) are strict positive decimal safe integers. The per-session and
per-principal values cannot exceed the global limit. Invalid values fail before
inventory or listening; Compose forwards the same defaults. The operator-only
`/api/config` view reports this validated startup limit snapshot, not live
connection counts.

Ordinary session creation uses one durable coordinator in the host runtime
namespace. `ORDINARY_SESSION_CREATE_MAX_CONCURRENT` (default `2`),
`ORDINARY_SESSION_CREATE_MAX_CONCURRENT_PER_PRINCIPAL` (default `1`),
`ORDINARY_SESSION_CREATE_STARTS_PER_PRINCIPAL` (default `4`), and
`ORDINARY_SESSION_CREATE_WINDOW_SECONDS` (default `60`) are strict positive
decimal safe integers; per-principal concurrency cannot exceed the global
limit, and the seconds-to-milliseconds conversion must be safe. Invalid values
fail before inventory, timers, or listening. The operator-only `/api/config`
view reports the validated snapshot. `POST /api/sessions/creation-admission/recover`
is an operator-only, bodyless emergency override for an expired quarantined
creation lease; it accepts no principal or fence and reports `providerOutcome`
as `unknown` when it recovers one.

### Compiled Cthulhu world-model binding policy

Compiled Cthulhu publication bindings are disabled unless both
`COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH` and `CTHULHU_DATASET_PATH` are
configured. Configure neither for the disabled state; configuring only one,
or a malformed/unreadable policy or dataset, fails startup before namespace
inventory or listening. In Compose, keep the default empty pair, and use
`docker-compose.world-model.yml` only when deliberately enabling the explicit
read-only policy-file and dataset-root mounts at the fixed container paths
named by those variables.

The policy is a startup-only, exact JSON allowlist for
`(moduleId, artifactHash)` tuples, their sorted work scopes, corpus scope, and
transfer policy. Requests, PDFs, and LLM output cannot choose policy files,
dataset roots, work IDs, or transfer behavior. The operator-only `/api/config`
view reports only enabled state, accepted-policy hash, binding count, and
dataset id/version; it never returns paths, module IDs, work IDs, or the
policy body.

Operationally, first publish an unbound bundle to obtain its deterministic
artifact hash. Add that exact hash and module ID to the reviewed policy, then
restart and resolve/publish again: the bound bundle has a distinct immutable
catalog identity because the binding participates in its seed. A bound bundle
is authorized at issuance time and remains durable; this deployment policy
does not promise hot revocation of already-issued bundles.

Only exact `NODE_ENV=development` or `NODE_ENV=test` permits either explicit
development escape hatch: `ORDINARY_SESSION_AUTH_MODE=development_anonymous`
or `ORDINARY_SESSION_INTENT_POLICY=development_fallback`. Missing, empty,
unknown, mixed-case, and production-like values all fail closed. The
operator-only `/api/config` view reports the startup-validated port and session
timeout; an invalid direct host configuration returns a fixed `503` only after
operator authentication, without reflecting the supplied value.

LLM 凭据从宿主环境传入，不烘进镜像：

```bash
export LLM_API_KEY=...
export LLM_BASE_URL=...
export LLM_MODEL=...
```

编译器控制面另有独立的 Bearer 凭据，不复用 LLM key，也不从请求体、查询参数或角色 header 接受身份：

```bash
export COMPILER_OPERATOR_BEARER_TOKEN=... # 独立随机值，至少 32 个可打印非空白字符
export COMPILER_KEEPER_BEARER_TOKEN=...   # 必须同时配置，且不得与 operator token 相同
```

`docker compose` forwards both control-plane tokens and the player-delivery secret from its environment. It pins the delivery TTL defaults to 900/604800 seconds and stores digest-only claim state at `/app/data/compiled-player-delivery` inside the existing `trpg_data` volume; export `COMPILER_PLAYER_DELIVERY_HMAC_SECRET` before startup when browser player delivery is wanted.

Compiled snapshots now coordinate their own cross-process CAS, quota, and GC through a separate durable coordinator; that bounded snapshot fact is no longer, by itself, the single-writer reason. Snapshot quota exhaustion returns only the fixed safe HTTP `507` message. A quota of zero forbids only immutable snapshot body/header publication: the SQLite coordinator may still bootstrap, and its durable files still count toward disk use. The service root still requires one active writer: mutable claim sidecars, ordinary sessions, and session metadata do not share that coordinator. Do not mount the same `trpg_data` volume into horizontally scaled independent server replicas until those objects have an external transactional coordinator as well. The contract assumes a trusted local filesystem and does not close symlink/junction root replacement, power-loss, or NFS/SMB semantics.

缺少任一项、值过短/含空白或逗号、两项相同，都会让编译器、catalog 和编译会话创建路由以 503 fail-closed；服务器的其它既有路由仍可启动。operator 可准备、自动解析、创建可信 presentation review、发布并读取完整产物；Keeper 只能读取已发布 bundle，并只能从 `bundleId` 创建编译会话；player 无编译器控制面权限。生产部署应由 secret manager 注入并定期轮换，不能把真实 token 写入仓库或日志。当前两枚静态 token 是最小部署边界；多用户 IdP、逐人审阅审计和 authenticated ordinary WebSocket replacement 仍需外部 host authenticator。

### Public PDF prepare ingress

Authenticated POST /api/compiler/prepare requests use two separate process
guards. Before the handler obtains a body reader, a shared ingress controller
admits at most five requests process-wide and two for one exact
host-authenticated principal. Capacity refusal is an immediate 429
PREPARE_INGRESS_BUSY with Retry-After 1; the rejected request body is not
pulled. Content type, module ID, its UTF-8 bound, and declared Content-Length
are rejected before the slot. Query parameters, headers, module IDs, and PDF
content do not select the principal bucket.

The ingress lease remains held through bounded body consumption, the isolated
parser/validator pair, and catalog publication. Abort, timeout, invalid PDF,
worker refusal, catalog failure, and exceptions release it idempotently. The
existing worker admission remains independent at one active worker plus four
waiters: ingress bounds bodies and connections held by this process, while the
worker admission bounds parser processes. These are per-process protections,
not a gateway or distributed replica quota. Cross-replica quotas, rate/cost
budgets, and per-person IdP policy remain deployment work.

### Public compiler JSON ingress

Authenticated operator requests to `/api/compiler/resolve`,
`/api/compiler/auto-resolve`, `/api/compiler/presentation-reviews`, and
`/api/compiler/presentation-workbench` share one process-local, no-queue
ingress controller. After authorization, the server rejects invalid JSON
Content-Type or declared Content-Length before admission. It then admits at
most eight requests process-wide and two for one exact host-authenticated
principal. Capacity refusal is an immediate `429
COMPILER_JSON_INGRESS_BUSY` with `Retry-After: 1`; the rejected request body
is not read. Query parameters, headers, body fields, artifact identifiers,
and route names cannot select the bucket.

The lease spans the complete request body, strict UTF-8/JSON parsing, catalog
work, resolution/projection, and automatic provider plus durable publication
work. The durable automatic-compiler admission is still a separate guard. If
automatic resolution returns a deadline or lost-fence refusal while a provider
ignoring abort continues in the background, ownership of the JSON lease moves
to that exact background drain and is released only when it settles. A stuck
provider therefore consumes bounded capacity instead of silently reopening a
slot. Request-body cancellation uses the same physical-lifetime rule: PDF and
JSON ingress capacity is retained until the actual reader cancellation settles.
These are in-process protections, not gateway or cross-replica quotas;
start-rate/cost policy, per-person IdP, and provider exactly-once remain
deployment work.

### Compiled-session creation ingress

Authenticated `POST /api/sessions/compiled` requests share one process-local,
no-queue controller. Production admits at most two active creations in the
process and one for an exact operator/keeper fingerprint. JSON Content-Type
and declared Content-Length reject before admission. Capacity refusal is a
stable `429 COMPILED_SESSION_CREATION_BUSY` with `Retry-After: 1`; it performs
no player-assignment call and obtains no body reader. Query parameters,
headers, body fields, bundle identifiers, archetypes, and generated session
IDs cannot select the bucket.

The lease covers player assignment, body consumption, catalog work, runtime
namespace reservation, invitation, staging construction, generation-zero
snapshot publication or exact recovery, and registry installation. Abort,
timeout, actual-byte overflow, and read failure return promptly but keep the
slot while the underlying reader cancellation is still draining. This body
drain contract is shared with PDF and compiler JSON ingress.

Every recognized compiler/compiled route is authenticated before a request can
construct or reconcile durable runtime inventory. The host authenticates once
and passes a frozen, module-private, single-use capability to the inner route.
That capability is bound to the exact Request, method, path, route policy, and
principal. A forged, replayed, or cross-request capability is rejected before
catalog or body work and never falls back to a second authenticator call.

This is process-local concurrency control. Cross-replica or gateway admission,
durable starts/cost budgets, per-person IdP policy, and provider exactly-once
remain deployment responsibilities.

### Automatic-admission startup barrier

Production main creates the host-owned automatic-admission root and validates
the durable coordinator before namespace inventory, hydration, cleanup timers,
or listen. The exact initialized controller is then shared by automatic
compilation and operator recovery. Startup verifies the persisted policy and
the leases, health, and starts table columns used by the first acquisition.
It does not consume a start or lease, and it does not read or clear a
quarantine row. An incompatible policy or auxiliary schema therefore fails
startup instead of waiting for the first automatic request.

An explicit config root, COMPILER_AUTO_ADMISSION_ROOT, or fallback
COMPILER_CATALOG_ROOT must be non-empty and already exact: whitespace-only
values and values with leading or trailing whitespace are configuration
errors. Explicit precedence remains config root, then auto-admission root,
then catalog root. Invalid scalar server configuration such as PORT is still
rejected before selecting or writing the admission root. These guarantees
cover the automatic-resolution coordinator only; ordinary PDF prepare/resolve
admission and provider exactly-once semantics remain separate open work.

### Automatic-admission reclaim recovery

`POST /api/compiler/auto-admission/recover` is an operator-only, bodyless recovery operation for the durable automatic-compiler admission coordinator. It is not part of `auto-resolve`, accepts no query parameters, fence, identity, or request body, and Keeper/player credentials receive `403` before any coordinator work. It uses the same host-resolved operator authentication as every other compiler control-plane route; a caller-declared role never participates.

Use it only after confirming that the process owning a permanently quarantined, expired model call has died or that the provider has acknowledged cancellation. The operation deletes exactly the persisted quarantine's `(fence, owner_instance)` lease and no other/live lease. A `200` response with `recovered: true` means that one such quarantine was cleared; `recovered: false` is an idempotent no-op when none exists. It remains available while automatic compilation is disabled so a crash can be cleared before a later re-enable. Coordinator/policy/storage failure returns `503 AUTO_ADMISSION_RECOVERY_UNAVAILABLE` with `Retry-After: 60`; do not treat that as a successful recovery or retry automatic work around it.

### 普通会话 owner 身份

`ORDINARY_SESSION_AUTH_MODE=required` 是部署默认值。只有值**精确等于**
`development_anonymous` 且 `NODE_ENV` **精确等于** `development` 或 `test`，才允许开发期匿名兼容；
缺失、空串、未知值、大小写变体与 production 都 fail-closed。operator 或 Keeper 可以创建普通会话，player 不可以。服务只把
host principal 的 fingerprint 写入独立的 versioned binding（schema 1.0），绝不把原始
id、token 或 cookie 落盘。

普通会话的 create、list 与所有 `/:id` owner 路由都在读取 body、factory/opening 或
registry locator 之前认证；foreign 与 unknown 都保持 opaque。持久 metadata 与 live
binding 必须同时一致，缺失、旧版或篡改均 fail closed。`required` 和 `prohibited` 下，
旧 ordinary WebSocket 对所有 locator 都关闭。现有 ordinary session 仍不承诺进程重启后
完整 hydrate。

若部署以共享环境 Bearer 提供 host 身份，它代表的只是**一个 service account**，不是逐人
IdP，也不提供 token registry/rotation 或 per-person audit。多用户 IdP、轮换与审计、
authenticated ordinary WebSocket replacement、multi-writer/file locking、跨文件 crash
consistency 仍是开放运维工作。

### 普通 HTTP 意图策略

`ORDINARY_SESSION_INTENT_POLICY=required` 是普通 `POST /api/sessions/:id/action`
的部署默认值，而且由服务器决定；请求 body 不能选择降级。只有值**精确等于**
`development_fallback` 且 `NODE_ENV` **精确等于** `development` 或 `test` 时，才允许旧 regex 兼容路径。
缺失、空串、未知值、大小写变体与 production 即使设置该值也保持 `required`。

在 `required` 下，缺少可用 LLM client、显式离线、breaker、调用错误或 15 秒 deadline
都会稳定返回 503；模型 HTTP JSON 或严格 ActionIntent 校验无效会返回 422。两者都在
round、时间、history、world、metadata 或 action side effect 之前终止，也不会向公网返回
模型原文。少数确定性本地协议仍可离线执行，但必须是会话已验证的精确命令（例如裸模组
列表或当前目录中的精确模组名、当前同伴的精确 id/name），不是自然语言的第二套解释器。

普通 action body 在认证后以累计 8 KiB 上限读取，超限为 413；`input` 还限制为 1000
Unicode code points，超限为 422，二者都在模型调用和状态变更之前拒绝。意图模型调用
使用独立的单次预算：15 秒、最多 128 tokens、1 attempt；它不继承叙事调用的重试语义。
不要把 API key 放入日志、breaker key 或诊断内容。

这不是身份或实时协议的替代品：共享 Bearer 仍只代表一个 service account，且 ordinary
WebSocket 仍拒绝访问；部署了 IdP、逐人审计或 authenticated WebSocket 时，应在 host
边界另行实现，而不能靠此 intent policy 推断身份。

缺 LLM 凭据时服务仍可启动，叙事可退化成本地兜底的短句；但默认 required 的普通 HTTP
action 会返回 503。技能检定、掷骰和上述精确本地协议不需要模型，不受这项可用性差异影响。

`data/`（会话存档、模组 JSON、SQLite）挂在具名卷 `trpg_data`，不入镜像。

---

## 四、已知缺口

**音频在 Linux 容器里没有。** `frontend/public/{bgm,voice}/*.wav` 都是生成物、不入库，`.dockerignore` 也排除了它们。

- 环境音：`scripts/gen-bgm.ts` 是纯 TS 合成，容器里能跑，但目前没接进构建流程。
- 预制语音：`scripts/gen-speech.ts` 走 **Windows SAPI**，Linux 下跑不了。当初就标注过它是"本机可验证的实现，不是生产选型"——这一点现在到账了。要么在 Windows 上预先生成后随镜像带走，要么换一个跨平台的合成后端。

两者缺失都只是静默不放，不影响叙事流程。

**Docker 合约已静态复核，但 `docker build` 仍未经实跑验证。** Dockerfile 精确固定
`ARG BUN_VERSION=1.3.14`，前端使用 `oven/bun:${BUN_VERSION}`，后端使用
`oven/bun:${BUN_VERSION}-slim`；前端安装为 `bun install --frozen-lockfile`，后端安装为
`bun install --frozen-lockfile --production`，没有 `|| bun install` 降级。根目录 production
frozen dry-run、frontend frozen dry-run 和 `frontend` 的 `bun run build` 都已在 host 上退出
0；最后一项为 Vite 6.4.3、33 modules、1.23s。`CTHULHU_MODEL_PATH` 的 Cthulhu aggregate
路径也已与 `.env.example` 对齐为 `cthulhu/extracted/cthulhu_world_model.jsonl`。

这些是静态/host 合约证据，不是镜像证据：本机 Docker 命令不可用，故没有实际 image build
或 Linux-native dependency 验证。`assets/` 不存在不再阻碍 Docker build：它被排除在构建
上下文之外，只能通过第二节的显式 read-only runtime mount 提供。legacy aggregate 只用于 migration analysis，不能
把它当作完整 compiled dataset 或已启用的 production world binding。生产 compiled world
binding now uses the startup-loaded exact tuple policy described above; it does
not add policy hot revocation for already-issued bundles. `docs/notes/index.json`
is intentionally not refreshed here because it is generated/owned separately.

---

## 五、启动时间

| 阶段 | 耗时 |
|---|---|
| 服务就绪 | 2–3 秒 |
| 首次建会话（含读 229MB 世界模型 + LLM 开场白） | 约 11 秒 |
| 之后每次建会话 | 由 LLM 决定，模型已常驻 |

---

## 六、P2 Docker liveness（不是 readiness）

Dockerfile 只有一个 exec-form Bun `HEALTHCHECK`：interval 30s、timeout
5s、start-period 20s、retries 3。它运行容器内的
`src/api/container-healthcheck.ts`，不用 shell、curl 或 wget，也没有新增
HTTP API。检查器严格接受 `PORT` 1..65535，在四秒内 loopback `GET /api`；
只有 2xx 且 JSON `status` 为 `ok` 才 exit 0，其他响应、非 JSON、连接错误、
超时或非法端口都静默 exit 1。

这是**liveness**，不是 readiness：它不证明世界模型或运行期挂载的 assets 已可用、
LLM 可用、会话能创建或应用已可对外服务。回归先在旧实现得到 3 pass / 6 fail
/ 21 assertions；删除 `HEALTHCHECK` 为 3 / 1 / 8 red，放宽为任意 200 为
4 / 1 / 13 red，精确还原后绿。权威全量
`bun test --parallel=1 --timeout 30000` 为 5075 tests / 451 files /
5041 pass / 34 skip / 0 fail / 33733 expect calls / 462.98s；这不是
Docker image 或 Linux-native 验证，且本轮未运行 standard preflight。

frontend production build 已在 host 成功复跑：Vite 6.4.3、33 modules、
862ms。此前 sandbox 内 esbuild child spawn EPERM 不是产品 build 失败，
host 成功也不是 image build。仍须实测真实 Docker image/Linux、按需的只读 world-model
mount、运行时 UID/卷所有权、音频产物，以及 reverse proxy/TLS。它们以及
`todo-65` 和生产质量目标均保持开放。

### P2 后续 preflight 与环境边界

上述「本轮未运行 standard preflight」仅描述 liveness 证据写入时的状态，现由后续
标准 `bun scripts/preflight.ts` exit 0 补充：315 boolean / 0 discarded，
generated/handwritten/structured/section refs 3 / 8 / 1 / 3，typecheck 0，
5075 tests / 451 files 与 unwired 46 均精确匹配，hooks 为 `.githooks`。

这仍不是镜像验证。随后只读环境检查 exit 0，报告 DockerCommand 缺失、`assets/`
目录为 false、两个必备模型文件均为 false；因此没有 pull、build image 或 Linux
运行。真实 Docker/Linux、read-only world-model mounts、运行时 UID/volume、音频与 proxy/TLS
仍待验证，不能由 preflight 绿灯推断为完成。

---

## 七、P2 Docker non-root 与卷升级

精确的官方 `oven/bun:bun-v1.3.14-debian-slim` 镜像创建了 UID/GID 都为
1000 的 `bun` 用户，但没有 `USER`，所以此前最终镜像以 root 运行。Dockerfile 只在
`VOLUME` 前创建并将 `/app/data` 交给 `bun:bun`，随后以唯一的 `USER bun` 运行既有
HEALTHCHECK 和 CMD；它不 `chown /app`，不引入 root fallback/init，也不改 compose。
server 的默认持久化写入仍是 `/app/data`，healthcheck 只读。

新的本地 named volume 会从镜像目录得到匹配的 ownership。**已有 root-owned
`trpg_data` 卷不是自动升级的。** 操作员必须先停服、完成可恢复备份并确认正确的卷名；
下面是一次性、可审查的迁移命令（它会递归改写该卷中 `/app/data` 下所有文件和目录的
UID/GID，确认这一影响后才执行）：

```sh
docker run --rm --user 0:0 --entrypoint chown \
  --mount type=volume,source=trpg_data,target=/app/data \
  oven/bun:bun-v1.3.14-debian-slim -R 1000:1000 /app/data
```

迁移完成后再启动服务。bind mount、NFS/SMB、external volume driver 和 user namespace
必须由宿主/驱动预置为 UID/GID 1000 可写；镜像不会修复它们。将持久化根覆写到
`/app/data` 外时，该新根同样必须预先可写。CLI play-logs 与 analysis 不属于 server
image 的承诺。

本轮没有 Docker/image/Linux 或真实卷迁移实跑：DockerCommand 缺失且 `assets/` 及
必备模型文件仍缺失。上述命令是操作员迁移步骤，不是已完成的验证；这些部署边界、
`todo-65` 和生产质量目标保持开放。

---

## 八、P2 优雅停机：代码级契约与部署验证边界

Compose 现在显式使用 `stop_signal: SIGTERM` 与 `stop_grace_period: 20s`。应用自身的
停机窗口为 10 秒：先关闭请求 gate（新请求稳定为 503），以 `stop(false)` 和 WebSocket
1001 进行第一轮关闭，再让 listener close 与 in-flight drain 共用这一个 10 秒预算，最后
进行第二轮 WebSocket sweep。只有所有步骤成功后，才去重并关闭 sessions；timeout、listener
失败或 WebSocket 关闭失败都会 fail closed，保留 sessions 并让信号路径以 exit 1 结束。成功
路径依赖自然的进程终局，不强制 `exit(0)`。

这不是「保证优雅」或 readiness 承诺。10 秒只是 best-effort：合法 action body/intent
路径可占用 15 秒，auto compile 可占用 120 秒，二者都可能越过该窗口；此时语义是
crash-like recovery，不是证明已完成排空。WebSocket 关闭会尽量全部尝试；若任意连接失败，
controller 返回 `websocket_close_failed` 并保留 sessions，而不是吞掉异常后假报成功。

该约束已有静态与测试证据（Compose 的结构化 YAML 比较、request gate、listener/in-flight、
WebSocket sweep、失败保留 sessions），但**尚未运行 Docker**：DockerCommand 缺失，未实测
Linux/PID 1、`docker stop`、真实 in-flight+WebSocket 排空、或正常停机后不重启。assets 与
volume migration 仍未验证。本段不改变前述 liveness/non-root 边界，也不完成 `todo-65` 或
生产质量目标。
