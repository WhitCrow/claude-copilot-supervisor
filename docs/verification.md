# 验证说明（去标识摘要）

## 版本基线

- Node.js 22.23.2（支持要求 22.13+）。
- acpx 0.21.0、MCP SDK 1.32.2。
- 真实 GitHub Copilot CLI 1.0.103。
- 主管为实际 Claude Code，通过现有官方登录调用；不使用伪造模型响应。

本文件只保留行为结论，不包含账号、登录态、主机名、绝对本机路径、真实会话 ID 或原始对话日志。

## 普通回归

`npm run check` 先做语法/JSON 检查，再运行 Node 内置测试。它不调用真实模型。

- approval queue：等待、精确单次选项、期限及事件循环延迟、跨 job/重放/非法决定、防止替换成长效授权。
- runtime fixture：真实 acpx 软件与 ACP 测试子进程，实际验证文件/命令副作用、取消、期限和多轮会话。
- lifecycle：确定性 runtime 故障注入，覆盖关闭与启动竞态、取消准入、清理失败、会话上限、同步失败和 canonical error 保留。
- MCP：真正的 stdio 子进程和 MCP client，覆盖 start/status/decide、取消、断连和 session close。
- live evidence：拼接分片 text_delta，不在 JSON 序列化字符串里搜索连续标记。
- 文件 probe 策略：只接受 rawInput.fileName、所有 locations 和唯一 create diff 精确指向临时根下授权文件，且 oldText 为空、newText 为固定标记（最多一个尾换行和一个空行）。额外目标、命令、替换、删除及未知结构一律拒绝；这是合成 live 测试策略，不是通用沙箱。
- 强制取消故障注入：close 拒绝且 events/result 不结束时固定 failed、保留错误和可重试 handle，验证迟到结果不覆盖、长任务定时器不阻止子进程自然退出；清理一项失败仍继续其他会话、进程及 runtime shutdown。
- 运行版本报告：三个 live 脚本以本次本机 `copilot --version` 的实际输出和已安装 acpx 包版本填写 runtimeVersions；版本检测失败明确写 null 与错误，不回退到历史基线。单测注入同步探针，不要求安装 Copilot。

这些离线机制测试不能称为“真实 Copilot 所有故障场景测试”。

## 已执行的真实模型验证

### Copilot 原生文件

1. 原生 create/edit 发出 ACP 权限请求，包含位置、fileName/diff 和单次授权选项。
2. 请求被拒绝后，父控制器确认目标文件不存在。
3. 另一次原生写入被单次批准，批准前文件不存在，完成后父控制器读回预期合成内容。
4. 同一 Copilot 会话第三轮不读文件，准确回忆第一轮非秘密标记。

### Claude → MCP → acpx → Copilot

1. 真实 Claude 用自然语言分派任务给真实 Copilot，不使用 fixture JSON。
2. Claude 读取真实修改请求，先拒绝一次，再批准另一次。
3. 父进程在 approve 工具调用发出时检查目标文件尚不存在，最终独立读回内容；拒绝的目标文件始终不存在。
4. 第三轮 MCP 结果拼接出第一轮标记，且三次 start 返回相同 sessionId。
5. 最终由 Claude 显式关闭会话。

一次成功联调用了 11 次 MCP 工具调用，主管记录 12 个 turns。这是观察值，不是性能或成本保证。

### Copilot 原生命令

只允许运行一个向临时测试目录写固定内容的 Node 命令。确定性控制器将请求 command 与预期命令完整比较：拒绝不生成文件，批准一次后才生成预期内容。此测试不是通用 shell 安全判定器，也不是 Claude 模型对任意命令的审查准确率评估。

## 尚未覆盖

- 任意主动提问、固定选项问题、通用 elicitation。
- 任意插件、hook、MCP、已保存授权组合。
- 全部真实 Copilot 超时/断连/恶意后端故障路径。
- Windows 完整运行、强 OS 沙箱及恶意同用户进程隔离。
- 并发高负载和生产长期运行。

第一次真实联调的验证器曾因 token 分片错误地给出 false；修复证据解析器、补回归后，重新执行真实链路成功。不能以成功的模型总结代替独立证据，也不能抹掉失败历史来宣称可靠。

## 复测

```bash
npm run check
npm audit --omit=dev
```

真实模型脚本只在明确选择时执行，会消耗用量。它们在新的私有临时目录保存报告，日志不自动提交到仓库。仓库未默认配置云端模型任务、自动认证或远程 CI。
