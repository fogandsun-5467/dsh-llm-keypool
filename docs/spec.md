# dsh-llm-keypool — 实现规格（给并行开发者）

> 这是内部实现规格，不是用户文档。用户文档见 `README.md`。

## 0. 背景与已验证的内核事实

用户在 `cordis.patch.yml` 里配置了多个 provider（`ustc` / `ustc-techer` / `ustc-back`），
共用 `https://api.llm.ustc.edu.cn/`、同一批模型 id，但 `apiKeyEnv` 各自不同。
希望一把 key 额度用尽后自动换下一把，不手动改配置。

已从安装的内核（DSH 0.2.2-rc.1，`@deepseek-ai/dsh-agent` / `dsh-agent-loop`）核实的契约：

1. **`agent/request-error` waterfall**：payload 是
   `{ agent, turn, step, provider, failure, retryPolicy, signal }`。
   `failure = { code, message, providerRetryAfterMs? }`。
   `code` 可能是 `QUOTA` / `ACCOUNT_QUOTA` / `AUTH` / `RATE_LIMIT` / `PI_AI_ERROR` 等
   （DSH 用英文正则识别，中文报错常常落到 `PI_AI_ERROR`，所以插件必须自己看 `message`）。
   监听器若返回 `{ kind: 'retry' }`，agent loop 会在**同一轮、同一步**重跑失败步骤；
   若返回 `undefined`（或不返回），由下游/终态处理，轮次以该失败结束。
   **重试会重新解析凭据**（同一路由），所以换 key 仍然靠 `{kind:'retry'}` 生效；
   但**重试不会换路由**——0.2.2 的路由在步内是冻结的。

2. **0.2.2 起路由在步内冻结**：agent 在「提示词组装 + pre-step」之前就固定了本步的
   provider/model/reasoning effort（`dsh-agent-loop/lib/index.js` 的 `preStep()`：
   `const selection = this.model.current()` 先取，随后才 assemble + dispatch `agent/pre-step`）。
   - `agent/request` **不再允许改路由**：payload 只有 `{ agent, turn, step, signal }`，
     改写 provider/model 会让内核直接抛错
     （`agent/request proposed "x/y" after step preparation fixed "a/b"; use agent.model.select() before step preparation`）。
     官方文档也写明「`agent/request` 已废弃，不要再新增监听器」。
   - 换路由的唯一入口是 **`agent.model.select({ provider, model, reasoningEffort? })`**：
     它给「**尚未开始准备的下一步**」定下完整选择；`agent.model.current()` 读回当前选择
     （pending → 最近一次请求 → agent.options）。
   - **三个可用的时机**：
     | 时机 | 事件 | 选中的路由对哪一步生效 |
     |---|---|---|
     | 消息落进收件箱、驱动还没醒 | `agent/inbox/inserted`（payload `{ agent, message }`） | **尚未开始准备的下一步**（通常就是本轮第一步） |
     | 本步路由已固定 | `agent/pre-step`（payload 含 `modelSelection`） | **下一步** |
     | 本步请求失败 | `agent/request-error` | **下一步** |
   - `agent/inbox/inserted` 在 `ReactLoopInbox.mutate()` 里于 `session.append('agent/inbox/spliced')`
     之后同步 emit，早于 `wakeDriver()`；此时 `agent.model.select()` 安全（不会撞上
     "session append cannot reenter while another append is being published"）。
     注意内核也会把工具结果 / `additionalContexts` 以 "next-step" 拼进收件箱
     （`dsh-agent-loop/lib/index.js:972`），所以这个事件在轮次中途也可能触发；
     那时选中的路由落在**本轮的下一步**——与 `agent/pre-step` 同一套规则。
   - **不要**在 `session/event` 观察者里调 `agent.model.select()`：那次 append 还没结束，会被吞掉。
   - 内核的 `installModelSelection`（`dsh-agent/lib/index.js`）会在 `agent/pre-step` 里比较
     本步路由与上一次请求的路由，不一致时自动插一条 `modelSwitchNotice`——切路由会被自动播报。

3. **凭据热切换**：`dsh-llm-pi-ai` 的 `resolveApiKey()` 每次请求都调
   `credentials.resolve(ref)`（`lib/index.js:2886`），且 `credentials` 文档明确
   「轮换后的已存储密钥会作用于下一次请求，无需重启或修改配置」。
   所以换 key = `await ctx.get('credentials').set(activeRef, nextValue)` + `{kind:'retry'}`。

4. **禁止自造 session 事件**：`Session.append()` 不能设置 `ignorable: true`，
   写新 `type` 会让 Session 无法重新打开。两个插件都**只能写日志**
   （`ctx.logger.warn/info`），不得 append 任何 session 事件。

5. **不要抛异常打断宿主**：配置非法、服务缺失、写凭据失败 → `logger.warn` 后
   走 `next()`，绝不能把错误抛回 waterfall。

## 1. 文件与职责（并行边界）

| 文件 | 负责人 | 说明 |
|---|---|---|
| `lib/shared.js` | Lead（已完成） | 配额判断、预算、配置校验。**不要改** |
| `test/helpers/fake-ctx.mjs` | 维护者 | 伪 Cordis ctx / 凭据服务 / payload 构造。0.2.2-rc.1 迁移时补了 agent 桩（`createFakeAgent` 等） |
| `lib/key-rotate.js` | key-rotate-dev | 插件 B（凭据轮换） |
| `test/key-rotate.test.mjs` | key-rotate-dev | B 的单元测试 |
| `lib/route-pool.js` | route-pool-dev | 插件 C（路由池 fallback） |
| `test/route-pool.test.mjs` | route-pool-dev | C 的单元测试 |
| `package.json` / `cordis.patch.yml` / `docs/spec.md` | 维护者 | 0.2.2-rc.1 迁移时改了 `package.json`（版本、`engines.dsh`）与本文件 |

> 「不要改」是上一轮并行开发时的边界。0.2.2-rc.1 迁移（内核把路由固定在步骤准备时）由维护者一人完成，
> 动过的文件已在表里逐行注明——`lib/shared.js` 与 `lib/key-rotate.js` 至今未动。

测试命令（在项目根目录）：

```powershell
& node --test
```

只想跑两个插件的用例时：

```powershell
& node --test test/key-rotate.test.mjs test/route-pool.test.mjs
```

`package.json` 是 `"type": "module"`；用 ESM + `node:test` + `node:assert/strict`。

## 2. 插件 B：`llm-key-rotate`（lib/key-rotate.js）

### 导出

```js
export const name = 'llm-key-rotate'
export const inject = ['credentials']   // 没有 credentials 服务的 profile 里保持未激活
export function apply(ctx, config)      // 同步；内部注册 waterfall 监听器
```

### 配置（`cordis.patch.yml` 的 row config）

```yaml
activeRef: PROVIDER_KEY_ACTIVE        # 必填：provider 当前 apiKeyEnv 指向的那个凭据 ref
refs: [PROVIDER_KEY_A, PROVIDER_KEY_B, PROVIDER_KEY_ACTIVE]  # 必填：候选 key 的 ref 列表（可包含 activeRef）
codes: [QUOTA, ACCOUNT_QUOTA]       # 可选：触发轮换的 failure.code；默认 DEFAULT_CODES
patterns: []                        # 可选：替换默认 message 正则列表；默认 DEFAULT_PATTERNS（含中文）
watchProviders: [vendor-a, vendor-b]   # 可选：只对这些 provider 生效；省略/空 = 全部
maxSwitchesPerTurn: 3               # 可选，默认 3
dryRun: false                       # 可选：true 时只打日志不写凭据（联调用）
```

配置校验失败时的行为（必须）：`logger.warn` 一条能定位问题的消息，`apply` 直接 return（不注册监听器），**不抛异常**。

### 运行时行为（监听 `agent/request-error`，非 prepend）

1. 取 `failure`，若 `matchesFailure(failure, { codes, patterns, regexes })` 为 false → `next()`。
   建议在 apply 时用 `compilePatterns(config.patterns)` 预编译一次。
2. 若配置了 `watchProviders` 且 payload.provider 不在其中 → `next()`。
3. `budget.take(payload.agent, payload.turn, maxSwitchesPerTurn)` 为 false → `next()`。
   （预算在真正切换前消耗；同 turn 内重置。）
4. 取 `credentials = ctx.get('credentials')`；缺失 → `next()`。
5. `current = (await credentials.resolve(activeRef))?.value`；resolve 抛错 → warn + `next()`。
6. 逐个 resolve `refs`（每项都 `await`；抛错或空值跳过），得到有序去重数组
   `pool = [{ ref, value }]`（按 value 去重，保留第一个 ref）。
7. `pool` 少于 2 项 → `next()`（只有一把 key，轮换没有意义）。
8. 找 `current` 在 `pool` 中的下标；找不到按下标 -1 处理 → 目标为 `pool[0]`；
   找到 → 目标为 `pool[(index + 1) % pool.length]`。
   若目标 value 与 current 相同（理论上已去重不会发生）→ 继续往后找，找不到则 `next()`。
9. `dryRun` 为 true：只 warn；否则 `await credentials.set(activeRef, target.value)`
   （写失败 → warn + `next()`）。
10. `logger.warn` 记录轮换：**只允许出现 ref 名、池大小、序号，不允许出现 key 值**。
11. `return { kind: 'retry' }`。

### 重要边界

- `agent/request-error` 的 payload 里 `agent` 可能缺失（测试构造也可能缺）；`SwitchBudget` 已处理。
- 不要监听 `agent/request`；不要改 provider/model；不要碰 session。
- 监听器用 `ctx.effect(() => { const off = ctx.on(...); return off })` 或直接 `ctx.on`（返回 disposer）注册。

### 测试要求（`test/key-rotate.test.mjs`，至少覆盖）

1. QUOTA 失败 + 3 把 key → 写到下一把，返回 `{kind:'retry'}`，日志不含 key 值。
2. 中文 message（如 `余额不足`、`额度已用尽`）+ `code: 'PI_AI_ERROR'` → 仍触发。
3. 非配额失败（`RATE_LIMIT` 且 message 无配额词）→ 原样 `next()`（返回值等于 terminal 的返回值，`credentials.writes` 为空）。
4. 同 turn 连续失败 3 次后第 4 次不再切换（预算耗尽，`writes.length === 3` 或按你的 max 配置）。
5. 换 turn 后预算重置。
6. 池里只有 1 把 key → 不切换。
7. `dryRun: true` → 不写凭据但仍返回 `{kind:'retry'}`。
8. 听器注册后再 `disposeAll()`，之后 dispatch 不再触发（清理生效）。
9. 配置缺失（`activeRef: ''` / `refs: []`）→ logger.warn 且不注册监听器（dispatch 直接走 terminal）。

## 3. 插件 C：`llm-route-pool`（lib/route-pool.js）

### 导出

```js
export const name = 'llm-route-pool'
export function apply(ctx, config)
```

### 配置

```yaml
pools:
  - model: deepseek-flash          # 该池覆盖的模型 id（与 resolved.model 精确匹配）
    routes:                        # 有序候选路由
      - provider: vendor-a
      - provider: vendor-b
      - provider: vendor-c
        model: deepseek-flash-2    # 可选：该路由要改写成的模型 id；省略 = 保持原模型
codes: [QUOTA, ACCOUNT_QUOTA]      # 可选
patterns: []                       # 可选
cooldownMs: 600000                 # 可选，路由失败后的冷却时长，默认 10 分钟
maxSwitchesPerTurn: 3              # 可选，默认 3
dryRun: false                      # 可选：true 时只打日志、不记录冷却（便于联调）
```

配置校验失败 → warn + return，不抛异常。至少要有 1 个 pool，且每个 pool 有 `model` 和非空 `routes`。

### 运行时行为

状态：`Map<provider, cooldownUntilMs>`（闭包级，apply 每次重新初始化）+ `routesByAgent`（WeakMap，
agent → 本步固定的 `{ route, pool }`，由 `agent/pre-step` 填）。
`SwitchBudget` 用于按 agent+turn 限制切换次数。

**三个钩子，都用 `agent.model.select()` 选路，绝不改写 `agent/request`：**

1. **`agent/inbox/inserted`**（payload `{ agent, message }`）——为**尚未开始准备的下一步**选路：
   消息落进收件箱时驱动还没醒，选中的路由就是本轮第一步；内核把工具结果拼进收件箱时
   （轮次中途），选中的路由落在本轮的下一步。
   ```
   const current = currentRoute(agent)          // agent.model.current() → {provider, model}
   const plan = planRoute(current)               // 见下：{pool, current, target, reason}
   if (!plan || plan.reason === 'healthy') return
   selectRoute(agent, plan.current, plan.target) // agent.model.select({provider, model})
   ```
2. **`agent/pre-step`**（payload 含 `modelSelection`）——本步路由已固定：
   - 先 `await next()`，**原样返回 decision**（不改消息、不拒绝步骤）；
   - 用 `modelSelection` 记住本步路由（`routesByAgent.set(agent, {route, pool})`；
     不在池里就 `routesByAgent.delete(agent)`）；
   - 再按 `planRoute` 为**下一步**选路。
3. **`agent/request-error`**（非 prepend）——本步失败：
   - `failure` 不匹配（`matchesFailure`）→ `next()`；
   - 归因失败路由：先看 `routesByAgent.get(agent)`（provider 必须一致），
     否则回退到「provider 在池中唯一」的匹配；都不中 → `next()`；
   - 预算 `budget.take(agent, turn, maxSwitchesPerTurn)` 失败 → `next()`；
   - 标记当前 provider 冷却（`RATE_LIMIT` 用 60 秒短冷却；其余用「额度窗口剩余时间」与
     「固定冷却 `cooldownMs`」中更长的那个，读不到额度就只按固定冷却；`dryRun` 时跳过），
     `logger.warn`；
   - 为**下一步**选好下一条健康路由（`selectRoute`）；
   - **`return next()`**——不返回 `{kind:'retry'}`：步内路由被冻结，重试只会再撞同一条死路由；
     让失败照常冒泡，同时把下一步的路由准备好。下游（凭据轮换）拿到的就是这一次 `next()`，
     插件自己的逻辑失败时也只 warn 一次、绝不重复调用下游。
     （凭据轮换插件仍然返回 `{kind:'retry'}`：换 key 不换路由，重试是有效的。）

`planRoute(current)` 的规则：
- `current` 不在任何池里（provider **和** model 都要命中）→ 不动；
- `preferFirst` 打开 → 池序即偏好：取第一条健康的、同模型的路由；
- 否则只在当前路由冷却或额度用尽时，按池序环形找下一条健康的路由（跳过冷却/额度用尽/同一 provider）；
- 都没有 → `reason: 'healthy'`，不动。

`selectRoute(agent, current, target)`：`agent.model.select({ provider, model })`；
**只有 model 没变**时才把 `reasoningEffort` 一起带上（与内核 `applyConfiguredRoute` 的规则一致）。

4. 冷却判定 `isCooling(provider)`：`now < until`；过期即视为健康（惰性清除，不做定时器）。
5. 所有日志不得包含 key / 凭据值；provider/model 名可以出现。
6. 任何钩子都不许抛异常回 waterfall：出错 → warn + 继续。

### 测试要求（`test/route-pool.test.mjs`，至少覆盖）

1. 插件**不改写** `agent/request`：失败之后请求配置原样返回。
2. `agent/inbox/inserted` → `agent.model.select()` 被调用，选的是下一条健康路由（额度用尽时）。
3. `agent/pre-step` → decision 原样返回，且为**下一步**选好路由。
4. `agent/request-error` → provider 被冷却、状态面板记录切换与失败、且**返回下游的终态**
   （不是 `{kind:'retry'}`）。
5. 连续失败两把路由 → 依次选到第二、第三条；三把都冷却后不再选（交给失败）。
6. `route.model` 覆盖生效（选中的 `model` 被替换；未配置时保持不变）。
7. 非配额失败不触发、不冷却。
8. 冷却到期（`cooldownMs: 20` + 等待 ~30ms）后原 provider 重新可用。
9. `maxSwitchesPerTurn` 限制：预算用完后不再切换。
10. 不在池中的 provider 不受影响（既不选路也不冷却）。
11. `preferFirst`：池序即偏好；额度用尽的第一条被跳过；只同模型换路由。
12. GUI 配置文件（`$DSH_HOME/keypool/route-pool.json`）里的池子/开关/触发码优先于 row 配置。

## 3.1 额度窗口与回切规则（cn → max → 回切 cn）

以用户的实际场景命名（池内两条路由：`minimax-cn` 与 `minimax-max`，同一个模型
`MiniMax-M3.1-Flash`，`preferFirst` 打开）。规则对任意池成立。

### 术语

| 词 | 含义 | 谁判定 | 何时回池 |
|---|---|---|---|
| **冷却 (cooling)** | 临时停用一条路由 | 插件自己的 `coolingUntil` 表 | 冷却到期自动回池 |
| **耗尽 (exhausted)** | 额度读取器确认某个窗口剩余为 0 | `lib/quota.js` 的 `summarizeEntry()` | **只有该窗口重置才回池** |

### 规则

1. **池序即偏好**：`preferFirst` 打开时，每次选路先取池里第一条「同模型且健康」的路由。
   cn 排第一 ⇒ 正常情况走 cn。
2. **cn 的 5 小时窗口用尽** ⇒ cn 被判为耗尽 ⇒ 跳过 cn ⇒ 走 max。
   冷却时长取「各窗口重置时间的**较晚者**」（`lib/quota.js` 的 `resetAt`）：只有 5 小时窗口用尽时，
   就是 5 小时窗口的重置时间；周窗口也用尽时，就是周窗口的重置时间。
3. **5 小时窗口恢复** ⇒ 读取器读到 cn 剩余 > 0 ⇒ 耗尽判定消失 ⇒ cn 重新成为候选 ⇒
   **下一次选路优先切回 cn**——但还要等插件自己的冷却到期（见第 5 条）。
4. **cn 的周窗口也用尽** ⇒ 耗尽判定继续成立（**任一窗口为 0 即耗尽**）⇒
   即使 5 小时窗口恢复也**不再切回 cn**，直到周窗口重置。
5. **判定有两个来源，缺一不可**：额度读取器（额度用尽）与插件自己的冷却表（失败后的冷却）。
   一条路由只要被其中任何一方判定为不可用，选路就会跳过它：
   - 读取器每 60 秒预读一次（TTL 5 分钟），**它的缓存同样在进程内**；
   - 冷却表的时长取「额度窗口剩余时间」与「固定冷却 `cooldownMs`（默认 10 分钟）」中**更长的那个**
     （`RATE_LIMIT` 走 60 秒短冷却）。所以冷却到期不会早于额度窗口重置，窗口在 10 分钟内恢复时，
     回切会被冷却表推迟到 10 分钟之后。
   - 插件重启后**两个判定一起清空**：额度刚用尽时重启，那之后的第一个请求可能再失败一次，
     直到读取器重新读到数据。
6. **读不到就不阻断**：`exhausted()` 只承认「确认读到」的结果。读不到（凭据缺失 / 网络不通）
   按「未耗尽」处理，回落到固定冷却 `cooldownMs`（默认 10 分钟）。
   **此时第 3、4 条不成立**——「5 小时才回 cn」依赖能读到额度数据。
7. **切换落在下一步/下一轮**：0.2.2 步内路由冻结，额度用尽后切到 max 是「下一步」的事。
   由于读取器提前预读，正常情况下请求还没发出就已换走，用户看不到报错；
   只有额度刚用尽、读取器还没刷新（≤ TTL）时，第一个请求会失败并把错误冒泡，
   从下一轮起走 max。
8. **同模型约束**：`preferFirst` 只在同模型之间回切（`preferredRoute` 要求
   `candidate.model === resolved.model`）。cn 与 max 的 model id 必须一致，否则不回切。

### 实现落点

| 规则 | 代码 |
|---|---|
| 1 / 3 / 4 / 8 | `lib/route-pool.js` 的 `planRoute()` / `preferredRoute()` / `nextHealthyRoute()` |
| 2 | `lib/quota.js` 的 `summarizeEntry()`（`exhausted` / `resetAt`）→ `lib/route-pool.js` 的 `quotaCooldown()` |
| 5 | 读取器：`lib/quota.js` 的 `read()` / `cached()` / `exhausted()`（预读循环在 `index.js`）；冷却表：`lib/route-pool.js` 的 `coolingUntil` / `isCooling()`，时长在 `onRequestError()` 里取「窗口剩余」与「固定冷却」的较大者 |
| 6 | `lib/quota.js` 的 `exhausted()` 只承认确认读到的结果；`lib/route-pool.js` 的 `quotaCooldown()` 读不到时返回 undefined ⇒ 固定冷却 |
| 7 | `lib/route-pool.js` 的三个钩子（`agent/inbox/inserted` / `agent/pre-step` / `agent/request-error`） |

### 怎么确认这套规则真的生效

- 面板额度页（`GET /api/keypool/quota`）能看到 cn / max 的 5 小时与周窗口读数 ⇒ 读取器通了，
  第 2–4 条成立；
- 额度页读不到（`ok: false`）⇒ 只能靠失败后的固定冷却，第 3、4 条不成立；
- 额度页能读、但回切比窗口重置晚了 10 分钟以内 ⇒ 冷却表在起作用（第 5 条），不是读取器坏了；
- 切路由时对话里会出现内核自动插入的 `[model changed: …]`。

## 4. 交付标准

- 两个测试文件全绿（`node --test`）。
- 不留 `console.log`；只用 `ctx.logger.*`。
- 文件内 JSDoc 用英文（与 DSH 源码风格一致），测试名可用中文/英文。
- 完成后在回复里报告：改了哪些文件、测试命令与结果、设计上偏离本规格的地方及原因。
