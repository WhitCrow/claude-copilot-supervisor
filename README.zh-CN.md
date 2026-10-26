# Claude–Copilot Supervisor

[English](README.md) | 简体中文

本地 **Claude Code → MCP → acpx/runtime → GitHub Copilot CLI** 审批桥接。

Claude 可以委派任务、在同一 Copilot 会话中继续讨论，查看 Copilot 的工具请求，批准一次或拒绝，再让执行端继续。不是把 Copilot 伪装成 Claude 的模型，也不需要公共服务或后台守护进程。

> **实验性工具，不是安全沙箱。** 当前验证覆盖受限工具集的原生文件修改、命令审批与多轮上下文。尚未实现通用 `ask_user` / elicitation、跨进程恢复待审批请求或真正的中途 steering。详见 [安全边界](SECURITY.zh-CN.md) 和 [验证说明](docs/verification.zh-CN.md)。

## 架构

```text
Claude Code
   │ stdio MCP: start / status / decide / cancel / close
   ▼
本地 supervisor 进程
   ├─ 持续会话、短等待状态查询
   ├─ 挂起权限回调，精确选择 allow_once
   ├─ 超时、取消、关闭及资源上限
   ▼
acpx/runtime (createAcpRuntime)
   │ ACP stdio
   ▼
GitHub Copilot CLI
```

ACP 与 MCP 是不同协议；本仓库负责桥接。没有监听 TCP/HTTP 端口。它不是 GitHub、Anthropic 或 OpenClaw 的官方插件。

### 依赖致谢

嵌入式 ACP 运行时来自 [OpenClaw 维护的 acpx](https://github.com/openclaw/acpx)。本项目是在该依赖之上新建的主管/MCP 桥接，不是 acpx 的 fork，也不声称重写了其底层运行时。依赖许可证归各自项目。

## 安装

前提：

- Node.js **22.13+**、npm。
- 真实使用时：`copilot` 和 `claude` 在同一执行环境的 PATH 中，且分别完成登录。
- 不需要安装全局 acpx；锁定版本由本项目本地依赖提供。

进入本仓库后：

```bash
npm ci --ignore-scripts --no-fund --no-audit
npm run check
```

`npm run check` 执行语法检查和不调用模型的测试。测试通过内置 ACP fixture 和故障注入验证机制，不读取个人项目、不需要任何模型账号。临时文件使用 Node 的系统临时目录解析，支持 `TMPDIR` / `TMP` / `TEMP`。

如果尚未安装 Copilot，按 [官方安装文档](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) 安装，再在自己的终端执行登录：

```bash
npm install -g @github/copilot
copilot login --device-code
```

不要把密码、令牌或设备码填进本仓库、MCP JSON 或提示词。凭据库不可用时，CLI 可能回退到明文保存令牌；登录前按自己的安全要求检查官方 CLI 的存储方式。

## 接入 Claude Code

先建立一个**没有秘密或生产数据**的测试工程。复制 `examples/mcp.example.json` 为自己的本地配置（建议命名 `mcp.local.json`，已被 gitignore 排除），替换其中所有绝对路径。

真实 Copilot 的配置形状：

```json
{
  "mcpServers": {
    "copilot-supervisor": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/claude-copilot-supervisor/src/server.mjs",
        "--project-root", "/absolute/path/to/empty-test-project",
        "--state-dir", "/absolute/path/to/private-session-state"
      ]
    }
  }
}
```

然后在 Claude Code 中**临时加载**，无需写入全局设置：

```bash
claude --strict-mcp-config --mcp-config /absolute/path/to/mcp.local.json
```

`--strict-mcp-config` 会让该次 Claude 会话只加载显式配置的 MCP；它不会改动其他会话的设置。不要直接给整个服务器、主目录或含密钥工程授权。

建议给主管的指令：

```text
使用 copilot-supervisor 的工具完成我明确指定的任务。
启动后用 copilot_status(waitMs=10000) 查询状态，不高频空轮询。
遇到 waiting_approval，检查精确路径、diff 或完整命令。
只在我授权的工程与任务范围内批准一次；不允许扩大权限。
拒绝 sudo、凭据读取、对外发布、部署和无关路径操作，并向我说明。
完成后核验实际结果，最后关闭会话。
```

这些提示是主管的行为约束，**不是执行层强制策略**。不要将模型判断作为唯一安全边界。

### 不使用真实模型的演示

在上述配置的 `args` 末尾加入 `--fixture`，即切换到仓库内确定性测试 Agent；这时 prompt 不是自然语言，而是合成测试 JSON，例如：

```json
{"action":"write","file":"probe.txt","content":"approved test"}
```

fixture **不是 Copilot**，不调用模型；移除 `--fixture` 才会运行真实 Copilot。不得混淆两者的测试结论。

## MCP 工具

| 工具 | 输入 | 行为 |
|---|---|---|
| `copilot_start` | `prompt`，可选 `sessionId` | 创建任务或在原会话发下一轮消息，返回 `jobId` 和 `sessionId`；只等待会话准备，不等待任务结束 |
| `copilot_status` | `jobId`，可选 `waitMs`（0–10000） | 查看状态、有限长度输出和原始待审批请求；有审批/终态立即返回 |
| `copilot_decide` | `jobId`, `approvalId`, `decision` | `approve` 精确选择已提供的 `allow_once`；`deny` 选择一次拒绝或取消 |
| `copilot_cancel` | `jobId` | 撤销待审批并取消当前轮次；不能撤销已经产生的副作用 |
| `copilot_close_session` | `sessionId` | 释放会话及连接；日常工作结束时显式调用 |

典型流程：

```text
start → status → waiting_approval → 检查请求 → decide → status → 完成
                    ↑                                 │
                    └──────── 如有下一次操作 ───────────┘
```

- 不存在 `allow_once` 时不偷偷改用 `allow_always`。
- 过期、跨 job、重复使用的 approvalId 会被拒绝。
- `completed` 仅表示 Agent 轮次结束，**不等于任务成功**；拒绝操作后也可能正常 `end_turn`。
- 只有进程内续聊；本原型不恢复进程重启前的 public sessionId 或挂起 Promise。

详细协议和生命周期见 [docs/protocol.zh-CN.md](docs/protocol.zh-CN.md)。

## 运行与限制

```bash
npm start -- --project-root /absolute/path/to/test-project --state-dir /absolute/path/to/private-state
```

该入口的 stdout 仅供 MCP JSON-RPC 使用，不是交互 TUI。不要向 stdout 写调试日志。

默认配置：审批期限 60 秒；任务时限 5 分钟；启动握手预算 10 秒；取消宽限期 3 秒；最多 4 个会话、保留 64 条 job。状态目录可能含任务或代码，必须私有保存，不能提交。默认状态位于仓库 `.state/`；可用 `--state-dir` 显式指定。

当前 Copilot 启动参数关闭内置 GitHub MCP 和自定义指令，只开放 `view,create,edit,apply_patch,bash`。acpx 客户端的 fs/terminal 回调关闭，Copilot 原生工具走自己的执行路径；这不是完整日常开发工具集，也不是 OS 隔离。

测试主要在 Linux/Node 22 运行。不要把临时目录可移植性当成 Windows 端到端兼容保证；特别是 opt-in live 脚本的进程组退出逻辑尚未在 Windows 验证。

## 真实模型联调（显式选择，会使用用量）

```bash
npm run test:live:copilot-files
npm run test:live:copilot-commands
npm run test:live:claude-copilot
```

以上分别测试真实 Copilot 原生文件权限、精确命令权限，以及真实 Claude 审批真实 Copilot。它们在新的临时测试目录工作，保留私有报告，不把真实运行日志提交到 Git。

另有 `npm run test:live:claude-fixture`：只有主管是实际 Claude，执行端仍是 fixture。真实使用模型与普通回归严格分开。

## 项目结构

```text
src/                 审批队列、会话主管、stdio MCP 入口
scripts/             质量检查、显式 opt-in 模型联调、证据解析器
test/                离线回归与确定性 ACP fixture
examples/            不含凭据的通用 MCP 配置样例
docs/                协议和去标识验证摘要
```

## 隐私、公开与许可

本仓库只包含实现、测试与去标识文档；不包含登录态、个人配置、原始对话、真实运行 ID、机器路径或测试日志。仓库目前仍为 Private；公开需要所有者另行明确决定。源码可见性与许可证是两个独立决定。

本项目采用 [MIT 许可证](LICENSE)。Copyright (c) claude-copilot-supervisor contributors。依赖保持各自许可证。本项目不发布到 npm。
