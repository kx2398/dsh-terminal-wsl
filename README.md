# dsh-terminal-wsl · WSL 终端后端

给 DeepSeek Harness（DSH）补一个 **WSL 后端**：沿用内置的 `terminal_*` 工具，在 Windows 上
通过 `wsl.exe` 打开 Linux 子系统的持久交互式 bash，后端类型为 `wsl`。

- 复用官方 `dsh-terminal` / `dsh-terminal-bash` / `dsh-tool-terminal`，不复制终端实现；
- 与内置 `shell`（pwsh）后端并存，`terminal_open({ type: "wsl" })` 即切到 Linux；
- 另注册一次性 `wsl` 工具：单条 Linux 命令，**默认权限下自动发起一次权限申请**，不会让模型退回 PowerShell；
- Windows 工作目录自动映射为 `/mnt/<盘符>/...`，支持 SIGINT、行缓冲、输出上限、所有者隔离；
- 配置 bundle + 两个小插件（提示词 / 命令工具），无运行时依赖，`npm test` 离线可跑。

## 1. 安装

```text
# 从 GitHub 按 tag 安装
plugin_manager({ action: "install_bundle", target: "github:kx2398/dsh-terminal-wsl#v0.2.0" })

# 或下载 Release 里的 tgz 后本地安装
plugin_manager({ action: "install_bundle", target: "file:<path-to>/dsh-terminal-wsl-0.2.0.tgz" })

# 开发时可直接装本地目录（link 安装，改动即时生效）
plugin_manager({ action: "install_bundle", target: "<path-to>/dsh-terminal-wsl" })
```

安装后 `plugin_manager list_bundles` 里应出现 `dsh-terminal-wsl`（`enabled/installed`），
其 rows 含 `terminal-wsl-guidance`、overrides 含 `optional-persistent-terminals`。
安装/修改/卸载都会重新组合终端组，**已打开的终端会话会被关闭**。

## 2. 它做什么

DSH 内置终端栈分四层，本插件只动最后一步的「启动命令」：

| 包 | 职责 |
|---|---|
| `@deepseek-ai/dsh-terminal` | `ctx.terminals`：会话 id、所有者隔离、清理 |
| `@deepseek-ai/dsh-terminal-bash` | 后端：PTY 启动、提示符就绪检测、行缓冲、信号 |
| `@deepseek-ai/dsh-tool-terminal` | 模型工具：`terminal_open` / `send` / `read` / `signal` / `close` / `list` |
| `@deepseek-ai/dsh-experimental-terminal-bundle` | 把上面三个装进一个 `isolate: { terminals: true }` 组 |

插件在同一隔离组内再注册一个 `@deepseek-ai/dsh-terminal-bash` 实例，把 shell 换成
`wsl.exe`，于是：

- 新增后端类型 `wsl`，`terminal_open({ type: "wsl" })` 打开发行版内的 bash；
- 其余 5 个工具、输出上限、就绪检测、所有者隔离、进程树清理全部复用官方实现；
- 内置 `shell`（pwsh）后端继续可用，只是重组合时和其它终端一样会被关闭。

同时注册一个一次性 **`wsl` 工具**（`wsl-tool.js`）：直接以 argv 启动
`wsl.exe -d <distro> -- bash -lc <base64 命令>`，命令经 base64 转交给 bash，不经过
PowerShell 引号解析。它是默认权限下使用 WSL 的正路——见下面的「权限模型」。

## 3. 实现方式

**为什么覆盖整个组**：`optional-persistent-terminals` 组带 `isolate: { terminals: true }`，
组外的插件注入不到这个 `ctx.terminals` 实例；`terminal_*` 工具只认组内的后端。因此
`cordis.patch.yml` 按 id 覆盖该组，原样重声明四个内置子项，再追加一行 WSL 后端。
覆盖语义是「整体替换 config」，所以前四个子项必须与上游保持一致
（`docs/upstream-terminal-bundle.patch.yml` 保存了上游快照供比对）。

**启动命令**：

```yaml
shellPath: 'C:\Windows\System32\wsl.exe'
shellArgs:
  - '-d'
  - 'kali-linux'                                        # 目标发行版
  - '--'
  - 'env'
  - 'TERM=dumb'
  - 'PAGER=cat'
  - 'GIT_PAGER=cat'
  - 'PS1=dsh> '                                         # 后端约定的提示符尾部
  - "PROMPT_COMMAND=printf \"\\033]133;D;%s\\007\" \"$?\"; PS1='dsh> '"   # OSC 133;D 标记
  - '/bin/bash'
  - '--noprofile'
  - '--norc'
  - '-i'
```

**为什么用 `env` 注入**：WSL 不把 Windows 侧环境变量转发进 Linux 进程（实测仅靠后端传入的
`PS1`/`PROMPT_COMMAND` 拿不到就绪标记，启动会卡到超时），所以提示符变量必须在发行版内部
重设。`TERM`/`PAGER`/`GIT_PAGER` 同理：不补的话 `git log`、`less` 这类分页命令会挂起。

**提示词插件**（`index.js`）：向模型说明存在 `wsl` 类型、里面是 POSIX 环境、cwd 已映射，
避免模型只知道工具 schema 里写的 `"shell"`。

**权限模型（为什么需要一次审批）**：WSL 服务依赖命名管道，`workspace-write` 下连
`wsl.exe` 本身都起不来；而宿主的升级机制 `approveEscalation` 是「单次调用、`allowed-once`」，
持久终端读的又是会话级策略，无法借用。因此 `wsl` 工具在会话不是 `danger-full-access` 时，
会先通过 `ctx.approval` 发起一次针对该命令的权限申请（理由自动生成）：

- 人工批准，或 Auto Review 预设下由审查模型自动批准 → 本次以完全访问执行；
- 被拒绝、取消或没有审批通道 → **明确报错**，并提示模型向用户说明、不要改用 PowerShell 绕路；
- 会话已经是完全访问 → 直接执行，不弹审批。

持久 `terminal_open({ type: "wsl" })` 仍要求会话本身处于 `danger-full-access`。

## 4. 配置

修改 `cordis.patch.yml` 里的 `optional-terminal-wsl` 行即可：

| 位置 | 默认 | 说明 |
|---|---|---|
| `shellArgs[1]` | `kali-linux` | 目标发行版，`wsl.exe -l -v` 查看；如 `Ubuntu`、`docker-desktop` |
| `timeoutMs` | `60000` | 单次发送（启动及之后的每个 `terminal_send`）等待上限 |
| `shellPath` | `C:\Windows\System32\wsl.exe` | 一般不用改 |
| `backendType` | `wsl` | 想并存多个发行版时复制整行并改成 `wsl-ubuntu` 等 |
| `terminal-wsl-tool` 行的 `config.distro` | `kali-linux` | `wsl` 工具的发行版，需与上面 `-d` 保持一致 |
| `terminal-wsl-tool` 行的 `config.timeoutMs` | `120000` | `wsl` 工具单条命令的默认超时 |

其余可调项与官方后端一致：`rows`、`cols`、`scrollbackLines`、`scrollbackMaxBytes`、
`maxReadBytes`、`idleSilenceMs`、`disposeGraceMs` 等（见 `@deepseek-ai/dsh-terminal-bash` 文档）。

## 5. 重载与卸载

```text
# 改完配置后重载（先禁后启）
plugin_manager({ action: "set_bundle", target: "dsh-terminal-wsl", enabled: false })
plugin_manager({ action: "set_bundle", target: "dsh-terminal-wsl", enabled: true })

# 卸载
plugin_manager({ action: "remove_bundle", target: "dsh-terminal-wsl" })
```

## 6. 验证

### 离线自检（无需 DSH / WSL）

```powershell
npm test          # 插件契约测试 + 补丁结构自检
```

`test/mock-apply.mjs` 用 mock 服务验证 export 形状与提示词注册；`scripts/check.mjs` 比对
`cordis.patch.yml` 与上游快照，确认四个原有子项原样保留、只多出 WSL 行。

### 在线验证

```text
terminal_open({ type: "wsl", name: "linux" })
terminal_send({ sessionId: "pty-6", text: "uname -srm; id -un; pwd; echo \"$TERM $PAGER\"" })
```

期望（路径与用户名以占位符表示）：

```text
Linux 6.x-microsoft-standard-WSL2 x86_64
<your-linux-user>
/mnt/c/<path>/<to>/<workspace>
dumb cat
```

再验证跨调用状态与中断：`cd /tmp && export FOO=bar` → 下一次 `terminal_send` 仍生效；
前台 `sleep 300` 后 `terminal_signal` 发 `SIGINT`，`^C` 回到提示符且会话存活。
最后 `terminal_close` 关闭。

### 一次性 `wsl` 工具

```text
wsl({ command: "uname -srm; pwd" })
wsl({ command: "apt list --installed | head", workdir: "/tmp" })
```

期望：输出 Linux 内核串与 `/mnt/...` 路径；`workdir` 为 Linux 路径时在发行版内 `cd`；
非零退出渲染 `[exit code: N]`，超时渲染 `[timed out after Nms]`。会话处于
`workspace-write` 时，第一次调用会弹出权限申请，批准后同一命令即执行。

## 7. 已知限制

- **持久终端需要会话级完全访问**：`workspace-write` 下 ConPTY 命名管道（`\\.\pipe\conpty-*`）
  被拦，`terminal_open` 对所有后端都会报 `PTY shell exited during startup`。交互式 WSL 会话
  请先把会话切到 `danger-full-access`；单条命令改用 `wsl` 工具，它会自己发起权限申请。
- **审批粒度是「一次命令」**：升级结果只有 `allowed-once`，不会长期放行。嫌频繁可把会话设为
  完全访问，或启用 Auto Review 预设让审查模型代为批准。
- **沙箱隔离不覆盖 Linux 侧**：`wsl.exe` 是本地子进程，Windows ACL 沙箱约束不到发行版内
  进程及其 `/mnt/...` 写入，而 `sandbox:policy` 仍会告诉模型写入受限；请把它当作
  「完全访问语义」使用，不要用它承载未授权的写操作。
- **cwd 只接受 Windows 形式路径**（持久终端）：靠 `wsl.exe` 自动翻译；要直接进
  `/home/<user>` 需要后续版本加自定义 `spawnTerminal`（映射 `\\wsl$\<distro>\...`）。
  `wsl` 工具已支持 Linux 绝对路径（在发行版内 `cd`）。
- **发行版写死**：默认 `kali-linux`，换发行版改配置（两处：终端行与 `wsl` 工具行）。
- **上游耦合**：覆盖内置组，DSH 升级后需跑 `scripts/check.mjs` 并同步上游快照。
- **仅 Windows**：非 Windows 平台相关行 `disabled`，插件退化为空操作。

## 8. 与生态现有插件的关系

- 内置 `@deepseek-ai/dsh-experimental-terminal-bundle` 提供 `shell`（pwsh）与六个工具；
  本插件只是多注册一个 `wsl` 类型，不改工具、不改内置后端。
- 与 `dsh-session-mesh` 等其它 profile 插件互不依赖：mesh 管会话协作，本插件管终端基底。
- 若还有其它终端基底插件，只要 `backendType` 不冲突即可并存；同类型会触发
  `DUPLICATE_BACKEND`。

## 9. 开发

```
dsh-terminal-wsl/
├── package.json                              # dsh.bundle.patch / exports / engines.dsh
├── cordis.patch.yml                          # 终端组覆盖 + wsl 后端 + 提示词 + wsl 工具
├── index.js                                  # 系统提示词指引（终端类型 + wsl 工具）
├── wsl-tool.js                               # 一次性 wsl 工具（审批 + argv 安全执行）
├── test/mock-apply.mjs                       # 离线契约测试（提示词插件）
├── test/wsl-tool.mjs                         # 离线契约测试（wsl 工具与审批编排）
├── scripts/check.mjs                         # 补丁/上游一致性自检
├── scripts/leak-check.mjs                    # 敏感信息防泄漏检查
├── docs/upstream-terminal-bundle.patch.yml   # 上游组快照（DSH 升级比对）
├── locale/{en,zh}.json                       # Plugin Manager 标题/描述
├── icon.svg
├── .github/workflows/test.yml                # CI：语法 + 契约测试 + pack 检查
├── LICENSE
└── README.md
```

CI 不安装 DSH、不启动 WSL，只验证插件契约、bundle 清单、补丁结构与敏感信息；真实会话行为
需在 Windows + WSL 机器上手工验证。

## 10. 许可证

[MIT](LICENSE)
