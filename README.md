# dsh-llm-keypool

**DeepSeek Harness（DSH）的多 Key / 多模型轮换池**：侧边栏图形面板 + 两个后台兜底插件。
额度用完自动换下一条，不手动改配置、不重启。

> 背景：DSH 内核一个 provider 路由只能配一个 `apiKeyEnv`，`dsh-llm-retry` 只在同一条路由同一把 key 上重试，
> 额度类错误默认直接失败；社区市场也没有现成的多 key / 路由池插件。这个 bundle 补上这一块。

## 本仓库说明（fork）

这是 [NethielChou/dsh-llm-keypool](https://github.com/NethielChou/dsh-llm-keypool) 的 fork
（上游 MIT 协议，版权归原作者），在上游 0.1.3 的基础上加了两处改动：

1. **额度读取**（`lib/quota.js`）：面板里直接显示每个供应商 5 小时窗口和周窗口的剩余额度与倒计时，
   额度读到 0 的供应商会被提前跳过。切换规则：5 小时额度用尽 → 停用到本窗口结束；
   周额度用尽 → 本周不再使用，等下周自动恢复。
2. **优先用第一个套餐**（`preferFirst`，默认关闭，不影响原有行为）：勾选后池子顺序就是偏好顺序——
   总是先用第一条（额度小的先用完），第一条额度用尽才换下一条，额度窗口刷新后自动切回第一条。

**维护方式**：本仓库独立维护，**不与上游合并、不追上游的提交**。上游发布新版本时，
需要的改动（新的内核契约、面板字段、文档）手动带过来，改完在本仓库自己的分支上提交。
上游只作为参考实现与协议来源；本仓库的行为以本 README 与 `docs/spec.md` 为准。

从本仓库安装：

```sh
dsh plugin --profile web add github:fogandsun-5467/dsh-llm-keypool
```

## 功能

| 部分 | row id | 作用 |
|---|---|---|
| 能力 | 行 id | 说明 |
|---|---|---|
| **轮换池面板**（图形界面） | `llm-keypool` | 从 DSH 里**已经配好**的供应商和模型里勾选、排序，存成轮换池；显示当前路由、冷却中的供应商、最近切换记录 |
| **路由池 fallback** | `llm-keypool` | 当前路由额度用尽 → 冷却它 → **下一步**自动改用池里的下一条（可跨供应商、跨模型） |
| **凭据轮换**（可选，默认关闭） | `llm-keypool` | 同一个供应商有多把 key 时，额度用尽自动把下一把 key 写进当前凭据引用 |
| **额度读取**（可选，默认开启） | `llm-keypool` | 面板显示每个供应商 5 小时 / 周窗口的剩余额度与倒计时；额度用尽的供应商提前跳过，窗口刷新后自动恢复 |

> 一个包只挂**一行**（`llm-keypool`）：DSH 的浏览器模块系统按包名识别 bundle，一个包挂多个 Loader 入口会
> 触发 `duplicate factory registration`。面板和两个兜底行为都由这一行加载。

- 面板入口：侧边栏「**轮换池**」一行（与「用量/余额」同款样式；侧栏收起时是圆形图标）。
- 池子按**顺序兜底**：第一条优先，额度用完换第二条，依此类推；当前健康时绝不折腾。
- 勾选「**优先用第一个套餐**」后改成**池序即偏好**：有额度就一直用第一条（额度小的先用完），
  第一条额度用尽才换下一条；第一条的额度窗口刷新后会自动切回来；周额度用尽的套餐在周窗口刷新前不再参与。
- 保存即生效（写入 `$DSH_HOME/keypool/route-pool.json`，下一次请求读取），**不需要重启**。
- 只处理额度类失败；不写 session 事件、不改历史、不碰凭据值日志。

## 安装

要求：DSH 内核 `>= 0.2.2-rc.1`。

> **内核版本是硬要求。** DSH 0.2.2 起，agent 在「提示词组装 + pre-step」之前就固定了本步的
> provider/model/reasoning effort，`agent/request` 不再允许改路由（改了内核会直接抛错）。
> 路由池因此改为通过 `agent.model.select()` 选路，只在 0.2.2-rc.1 及以后的内核上工作。

### 从 GitHub 安装（推荐）

```sh
# 本仓库（fork，含额度读取 + 优先用第一个套餐）
dsh plugin --profile web add github:fogandsun-5467/dsh-llm-keypool

# 上游原版
dsh plugin --profile web add github:NethielChou/dsh-llm-keypool
```

或在 DSH 桌面客户端「设置 → 插件」里用本地目录 / 仓库地址安装，然后**重启 DSH**（客户端代码在启动时加载）。

### 从 npm 安装

```sh
dsh plugin --profile web add @nethiel/dsh-llm-keypool
```

### 本地开发 / 手动挂载

```sh
git clone https://github.com/fogandsun-5467/dsh-llm-keypool.git
dsh plugin --profile web add link:$(pwd)/dsh-llm-keypool
```

手动方式等价于：把仓库目录链接进 `profiles/<name>/node_modules/`，并在该 profile 的 `cordis.patch.yml`
插入 `cordis.patch.yml` 里的三行（面板行、route-pool 行启用，key-rotate 行 disabled）。
空池时面板行与 route-pool 行**完全不影响请求**。

## 使用

1. 重启 DSH，点侧边栏「轮换池」；
2. 「从已配置的模型里添加」→ 选供应商、选模型 → 加入池子；
3. ↑ ↓ 调整顺序（顺序就是兜底顺序）；
4. 需要时勾上「认证失败（401/403）也切换」（key 被吊销/失效时也自动换下一条；默认只对额度类错误生效）；
5. 「保存」；
6. 在面板「状态」里查看当前路由 / 冷却中的供应商 / 最近切换记录。

额度用尽时的行为：当前路由冷却（默认 10 分钟）+ **下一步**自动切到下一条健康的 `供应商/模型`；
全部冷却则这一步正常失败（不会死循环）。0.2.2 起内核在步内冻结路由，所以同一步内不会换供应商——
额度用尽的那一步会失败，兜底从下一步生效。

## 配置参考

面板写入的是 `$DSH_HOME/keypool/route-pool.json`：

```json
{
  "pools": [
    {
      "name": "我的轮换池",
      "routes": [
        { "provider": "vendor-a", "model": "model-1" },
        { "provider": "vendor-b", "model": "model-2" }
      ]
    }
  ],
  "cooldownMs": 600000,
  "maxSwitchesPerTurn": 3,
  "codes": ["QUOTA", "ACCOUNT_QUOTA"],
  "preferFirst": false
}
```

- `codes` 是**触发切换的失败类型**：默认 `QUOTA / ACCOUNT_QUOTA / RATE_LIMIT`（额度类 + 429 限流）。面板里的
  「认证失败（401/403）也切换」勾选项就是往这里加 `AUTH`；也可以在文件里直接写成
  `["QUOTA", "ACCOUNT_QUOTA", "AUTH"]`。
- `preferFirst` 决定池子怎么用，默认 `false`（**顺序兜底**：第一条额度用尽才换第二条，当前健康就绝不折腾）。
  改成 `true` 就是**池序即偏好**：每次都先用第一条（额度小的先用完），第一条额度用尽才换下一条，
  额度窗口刷新后自动切回第一条；周额度用尽的套餐在周窗口刷新前不再参与。
- **限流（429 / RATE_LIMIT）默认就会切换**，但只把该供应商冷却 **60 秒**（额度类失败才用完整的冷却分钟数），避免一次瞬时限流把好线路冻结 10 分钟。
- 除了 `codes`，默认还会按中英文报错文案（余额不足/额度用尽/quota exceeded 等）判断；文案特殊时在行配置里加 `patterns`。

也可以不用面板，直接在 profile 的 `cordis.patch.yml` 写行配置（面板文件优先）：

```yaml
- id: llm-keypool
  disabled: false
  config:
    routePool:
      pools:
        - name: 手写池
          routes:
            - provider: vendor-a
              model: model-1
            - provider: vendor-b
              model: model-2
      cooldownMs: 600000
      maxSwitchesPerTurn: 3
      # preferFirst: true                     # 可选：true = 按池序首选（先用额度小的，用完自动换大的）
      # codes: [QUOTA, ACCOUNT_QUOTA, AUTH]   # 可选：额外把哪些失败当作额度类错误
      # patterns: ['额度\s*(?:不足|用尽)']      # 可选：自定义报错文案正则（默认已含中英文常见措辞）
    keyRotate:
      enabled: false
```

凭据轮换（同一供应商多把 key）：

```yaml
- id: llm-keypool
  config:
    keyRotate:
      enabled: true
      activeRef: PROVIDER_KEY_ACTIVE        # provider 的 apiKeyEnv 指向的凭据引用
      refs: [PROVIDER_KEY_ACTIVE, PROVIDER_KEY_B, PROVIDER_KEY_C]
      maxSwitchesPerTurn: 3
```

> 也兼容 0.1.0 的扁平写法（`pools` / `codes` / `activeRef` / `refs` 直接写在行 config 顶层），
> 升级不会让旧配置失效。

> **为什么只有一个行？** DSH 的浏览器模块系统按**包名**识别 bundle，一个包同时挂多个 Loader 入口会被当成
> 组合错误（实测报 `duplicate factory registration`）。所以这个包只挂一行 `llm-keypool`，
> 路由池/凭据轮换两个行为由同一行在进程内应用。

> 内置的额度文案识别（可被 `patterns` 覆盖）：`insufficient quota/balance/credits`、`quota|usage limit exceeded`、
> `余额不足`、`额度用尽/耗尽/超限`、`配额不足`、`欠费`。如果供应商文案特殊，把实际文本加进 `patterns`。

## 工作原理

1. **凭据热切换**：`dsh-llm-pi-ai` 的 `resolveApiKey()` 每次请求都重新解析凭据引用，凭据服务文档也明确
   「轮换后的已存储密钥作用于下一次请求」——所以换 key 只需要改一个凭据值。
2. **选路时机**：0.2.2 的 agent 会在 `pre-step` 之前固定本步路由，所以路由池在三个时机说话：
   - `agent/inbox/inserted`：消息落进收件箱、驱动还没醒——这时选中的路由就是**本轮第一步**的路由
     （内核把工具结果拼进收件箱时也会触发，那时落在**本轮的下一步**）；
   - `agent/pre-step`：本步路由已经定下——这时选中的路由是**下一步**的路由；
   - `agent/request-error`：本步请求失败——冷却掉出问题的供应商，并为**下一步**选好下一条健康路由。
3. **不碰 `agent/request`**：内核会拒绝与本步固定路由不一致的配置（`agent/request proposed ... after
   step preparation fixed ...`），所以插件不再改写请求配置，改用 `agent.model.select()` 选路。
4. **失败不吞掉**：同一步内重试只会再撞同一条死路由（路由已被冻结），所以路由池**不**返回
   `{ kind: 'retry' }`，而是让失败照常冒泡，由内核把这次请求判失败，同时把下一条健康路由准备好。
   凭据轮换（换 key）不受影响：它换的是同一个供应商的 key，重试仍然有效。
5. **失败归因**：`agent/request-error` 只带 provider 不带 model，因此用「本步固定的池路由」归因，
   回退到「provider 在池中唯一」的匹配；只有 `provider + model` 同时命中池子才切路由。
6. **reasoning effort**：只在模型不变时随路由带走；换模型时不带 effort（与内核 `applyConfiguredRoute`
   的规则一致），避免把一个模型不认识的 effort id 传过去。
7. **额度窗口与回切**（勾选「优先用第一个套餐」时的完整规则，以 `cn` / `max` 为例）：

   | 情况 | 结果 |
   |---|---|
   | 正常 | 池序即偏好，先用 `cn` |
   | `cn` 的 5 小时窗口用尽 | `cn` 被判定耗尽 → 跳过 `cn` → 走 `max` |
   | 5 小时窗口恢复 | `cn` 重新健康 → **下一次选路优先切回 `cn`** |
   | `cn` 的周窗口也用尽 | 耗尽判定继续成立 → **不再切回 `cn`**，直到周窗口重置 |

   - 判定依据是**额度读取器**（面板额度页每 60 秒预读一次）：任一窗口剩余为 0 即「耗尽」，
     回池时间取各窗口重置时间的**较晚者**——所以周额度用尽的套餐，5 小时窗口恢复也带不回来。
   - 判定有**两个来源**：读取器（额度）与插件自己的冷却表（失败后的冷却）。一条路由只要被其中
     任何一方判为不可用就会被跳过；冷却时长取「额度窗口剩余时间」与「固定冷却（默认 10 分钟）」
     中更长的那个，所以回切不会早于窗口重置，窗口在 10 分钟内恢复时会晚 10 分钟。
   - **读不到就不阻断**：额度读不到（凭据缺失 / 网络不通）时按「未耗尽」处理，退回固定冷却
     （默认 10 分钟），此时「5 小时才回 `cn`」不成立——靠的是能读到额度数据。
   - 因为是预读，切换通常发生在**请求发出之前**，你看不到报错；只有额度刚用尽、读取器还没刷新的
     几分钟里，第一个请求会失败，兜底从下一轮生效。
   - 完整规则与实现落点见 `docs/spec.md` 的「3.1 额度窗口与回切规则」。

插件只写 `ctx.logger`，不 append 任何 session 事件（自造事件类型会让 Session 无法重新打开），
也不向 waterfall 抛异常。

## 验证

- 单元测试：`node --test`，**77/77 通过**（配置解析/预算/中文文案/冷却恢复/优先用第一个套餐/
  面板回环端点/浏览器半区加载/闲时无副作用/额度窗口解析），其中路由池的用例全部按 0.2.2 的新契约写：
  「不改写 `agent/request`」「收件箱插入时选路」「pre-step 时为下一步选路」「失败后冷却并为下一步选路」
  「失败不吞掉（不返回 `{kind:'retry'}`）」「池外供应商不动」「状态面板」。
- 端到端（真实 DSH headless + 本地 mock OpenAI 网关，0.2.1-rc.4 内核上的历史结论）：
  - 跨供应商跨模型兜底：`A/flash` 402 → 自动切 `B/chat`，`pong`、exit 0；
  - 全池耗尽：每条路由只试一次后正常失败，不死循环；BOM 配置、非法配置、只读降级均有覆盖。
  - 0.2.2-rc.1 起路由在步内冻结，同一步内不再切供应商，兜底落在**下一步**。
- 端到端（真实 DSH **0.2.2-rc.1**，独立临时 `DSH_HOME` + 本地 mock OpenAI 兼容服务，不碰正式配置）：
  - 插件在 0.2.2-rc.1 上正常加载，面板端点 `/api/keypool/status|config|catalog` 全部 200；
  - 真实 agent 回合里钩子确实触发：`pre-step` 记下本步路由（面板 `active`）；额度失败后
    `agent/request-error` 冷却该供应商并调用 `agent.model.select()`——会话投影里
    `modelSelection.pending` 是池中的下一条路由、`lastUsed` 是失败的那条，
    即新契约生效、且没有触发内核的 `agent/request proposed … after step preparation fixed …` 报错。
- 真实网关验证（LiteLLM 兼容网关）：无效 key 返回 `401 AUTH` → 自动切换有效的 key → 请求成功返回。
- 面板后端：`/api/keypool/catalog|config|status|quota` 单元测试覆盖 200/400/403/405 与写入后即时生效。

## 已知限制

1. 供应商报错文案需要能被识别（默认覆盖中英文常见措辞；特殊文案加 `patterns`）。
2. 同一账号下的多把 key 可能共享额度，轮换前请确认额度独立。
3. 换 key / 换模型会让供应商侧前缀缓存失效，切换后的第一轮输入 token 重新计费（成本略增）。
4. 冷却状态在内存中，重启后清空（首个失败会重新标记，不影响正确性）。
5. 只覆盖 agent loop 的模型请求（`agent/inbox/inserted`、`agent/pre-step`、`agent/request-error`）；
   `ctx.llm.stream()` 直连调用不受影响。
6. 面板依赖宿主 `sidebar.footer.action` 槽位与 `webServer` 回环端点（DSH Desktop / web profile 均满足）。
7. 0.2.2 起路由在步内冻结：**同一步内**不会换供应商；额度用尽的那一步会失败，兜底从**下一步**生效
   （想原地续跑可以重发消息）。

## 文件

```
index.js               bundle 根 + 面板 Host 半区（/api/keypool/* 四个回环端点：catalog/config/status/quota）
lib/client.js          浏览器半区（侧边栏入口 + 轮换池面板）
lib/route-pool.js      路由池兜底
lib/key-rotate.js      凭据轮换
lib/quota.js           额度读取（5 小时窗口 / 周窗口的剩余额度与重置时间）
lib/runtime.js         配置文件读写 + 当前路由/冷却/切换记录
lib/shared.js          配额判断 / 预算 / 池子规范化
cordis.patch.yml       bundle patch（面板+route-pool 启用、key-rotate disabled）
test/                  单元测试（node:test，零依赖）
docs/spec.md           实现规格（内核契约、行为步骤）
```

## 卸载 / 回退

- 面板在「设置 → 插件」或 `dsh plugin --profile <name> remove @nethiel/dsh-llm-keypool`，重启即卸载；
- 只想停用：把对应行改 `disabled: true`，重启；
- 面板保存过的池子文件在 `$DSH_HOME/keypool/route-pool.json`，可随时删除。
- 卸载不会修改你的凭据文件。

## License

MIT © NethielChou
