# 协议和生命周期

## 请求并非后台弹窗

Copilot 用 ACP 提交 `session/request_permission`；嵌入式运行时的异步 `onPermissionRequest` 保持等待。本桥接把请求保存为内存条目，Claude 通过 MCP 查询，再通过独立的 decide 调用返回决定。

`copilot_start` 返回 jobId 而不等待任务完成，避免“主管等执行结束、执行端等主管批准”的死锁。`copilot_status(waitMs=10000)` 最多短等十秒；一有待审批或终态立即返回，不持续阻塞审批。

## 状态

```text
running ──请求权限──> waiting_approval
   ↑                      │
   └───── approve/deny ────┘
   │
   ├─ completed：Agent 轮次结束（不等于目标实现）
   ├─ cancelled：请求取消并完成相应清理
   └─ failed：任务、超时或清理失败，保留错误
```

一轮可以多次请求权限。拒绝可能使 Agent 放弃该操作或结束当前轮次。真实 Copilot 在拒绝后曾返回“Operation cancelled”并正常 end_turn，因此调用方必须检查结果与副作用，不能只看 completed。

## 一次性决定

- public approvalId 使用随机 UUID，并绑定 jobId。
- 内部保存请求快照，展示时返回副本，外部修改不能改变已保存请求。
- approve 只选择确切的 allow_once optionId；没有这个选项时返回错误。
- deny 选 reject_once，没有时取消请求；不退回长期拒绝选项。
- 过期、重复、跨 job 的决定不会放行。
- 期限用单调时钟判定，在决定入口重新检查；不能只信赖事件循环定时器。

这些是桥接软件层的授权生命周期，不验证“模型所称的操作”与任意原生后端的执行字节一定一致。信任和隔离边界见 SECURITY.md。

## 中止与关闭

- MCP start 请求在会话准备期间被取消：撤销准入，释放新获得的 handle，不留下调用方不知道的 job。
- start 返回 jobId 后：独立任务继续，需 copilot_cancel 显式取消。
- 任务时限与启动握手时限分开，host 自己持有任务 deadline，避免超时竞态被迟到 end_turn 覆盖。
- 取消请求后保留后端 canonical failure，不把清理失败伪装成成功取消。
- 超出协作取消宽限期会尝试关闭相应连接；若清理无法完成，报告失败并对生命周期中记录的自有进程执行兜底终止。
- 强制取消立即固定为 failed，并清除 host 任务 deadline；迟到的事件、结果或异常不能覆盖该终态。result 保留 cancellationError 与 cleanupErrors，调用本身仍会抛出清理错误。
- 强制取消或整体 shutdown 时，只有 runtime.close 确认成功才移除对应会话；失败 handle 禁止新任务，可用 copilot_close_session 再试，整体 shutdown 也会再次尝试释放。failed 不表示资源已释放。
- stdio EOF、协议关闭或 SIGINT/SIGTERM 都进入同一个幂等关闭流程。它尝试所有会话清理，并调用 runtime shutdown；失败不会返回成功退出码。
- 不能撤销已完成写入/命令，不能保证捕获 Agent 自行脱离管理的后代进程。

## 资源与持久化

默认最多四个会话，历史 job 最多六十四条，单 job 最多一百条输出事件、单 text_delta 最多八千字符。输出是有限窗口，**不是完整日志**。思考流不向主管返回。

底层 session store 会写私有状态目录，可能包含任务或代码；审批 Promise 与 public job/session 映射只在进程内。即使状态文件仍存在，也没有跨进程恢复能力。close_session 释放连接后保留底层私有历史；用户自行决定何时安全清理状态目录。

## 当前工具选择

真实 Copilot 以 `--acp --stdio --disable-builtin-mcps --no-custom-instructions` 启动，工具集合为 `view,create,edit,apply_patch,bash`。没有开放 Agent 嵌套委派、web_fetch 等能力。

acpx 提供的客户端 fs 与 terminal callbacks 关闭。真实 Copilot 的 native file/native bash 已验证仍可经其自身执行路径运行并触发权限回调。此事实不意味着所有 native tools 必经同一回调。

ACP 的 `mode: steer` 在该运行时里按队列处理，不能宣传成 GitHub Copilot SDK 的 immediate 中途注入。当前本仓库仅发送 prompt。
