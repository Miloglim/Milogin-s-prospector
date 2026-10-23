# Navigator 本机外部入口

## 当前拓扑

```text
外部用户 / 中心后台
  -> https://rates.47.96.159.26.sslip.io（兼容入口 rates-office）
  -> 阿里云 Caddy :443
  -> 阿里云回环 127.0.0.1:18795
  -> SSH 反向隧道
  -> 本机 Navigator 127.0.0.1:8795
```

服务器 `nav-api` 已停止并退出自动启动，只保留为 compose 的 `legacy-navigator` 手动回退 profile。中心容器内部 `PROSPECTOR_NAVIGATOR_URL` 和 Caddy 的 `rates.47…` 都指向桥接端口 `18795`。本机 Navigator 的原端口不变。

阿里云 Caddy 配置文件位于 `/opt/logistics-api/releases/20261021T083709Z/Caddyfile`；桥接切换前备份为同目录 `Caddyfile.before-local-bridge-20261022T153000+0800`。compose 备份为同目录 `docker-compose.before-local-bridge-20261022T153000+0800.yml`。

## 安全边界

- 服务器专用账号为 `navigator-tunnel`，无登录 shell。
- 专用公钥只允许监听服务器回环 `127.0.0.1:18795`；不能执行普通服务器命令或其他端口转发。
- 家庭或公司路由器不开放 Navigator 入站端口。
- Windows 计划任务名为 `Milogin Navigator Office Tunnel`，运行 [守护脚本](<D:/Agent Basement/Milogin-s-prospector/scripts/navigator-office-tunnel.ps1>) 的安装副本 `%LOCALAPPDATA%\Milogin\navigator-office-tunnel.ps1`。
- SSH 正常退出或连接断开后，守护脚本等待 10 秒自动重连；日志位于 `%LOCALAPPDATA%\Milogin\Logs\navigator-office-tunnel.log`。
- 阿里云 `navigator-tunnel-watchdog.timer` 每分钟请求桥接健康接口；若 `18795` 仍被旧监听占用但健康失败，只终止受限 `navigator-tunnel` SSH 会话，本机守护脚本会重新连接。看门狗不重启 Caddy、中心服务或数据库。
- 本机 `Database/ops/runtime.json` 必须配置服务器中心 `center_auth_url=https://crm.47.96.159.26.sslip.io` 和 `trusted_proxy_https=true`。watchdog 启动服务时会传递受信代理设置；不要只改用户级环境变量。

## Navigator 重启

重启 Navigator 必须通过项目 watchdog，确保服务器中心身份和受信代理设置同时生效。不得改成其他端口或数据库：

```powershell
Set-Location 'C:\Users\YQN\Documents\正式版运价库\运价项目\Database'
& '.\.runtime\python\python.exe' '.\ops\watchdog.py' --force
```

启动后应同时验证本机健康和设备授权页：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8795/api/health/live'
```

## 检查与恢复

```powershell
Get-ScheduledTask -TaskName 'Milogin Navigator Office Tunnel'
Get-ScheduledTaskInfo -TaskName 'Milogin Navigator Office Tunnel'
Invoke-RestMethod 'https://rates-office.47.96.159.26.sslip.io/api/health/live'
Invoke-RestMethod 'https://rates.47.96.159.26.sslip.io/api/health/live'
```

如果健康检查失败，先确认本机 `8795`、电脑联网和 Windows 登录状态，再停止并启动同名计划任务。服务器端可检查 `ss -ltnp | grep 18795`，不直接开放该端口。

已验证直接结束隧道 `ssh.exe` 后入口短暂不可用，守护脚本随后自动建立新进程并恢复健康，无需人工重启任务。

已验证外部设备授权页返回 200；无效账号登录由服务器中心拒绝，异源请求仍返回 `origin_rejected`。尚未使用外部分公司真实账号完成登录、设备授权和查价的完整点击链。

## 已知边界

- 本机、网络或登录会话离线时，外部入口立即不可用；这是过渡方案，不是最终高可用生产部署。
- 本机 Navigator 已切换为服务器中心身份源。本机与外部同事统一使用中心账号及其 Navigator 产品准入；本机中心服务仍可供 Prospector 开发端等其他本机开发链路使用，但不再是 Navigator 的登录真源。
- 该入口不应绕过 Navigator 自身账号权限。管理员账号只发给授权管理员，普通分公司人员使用独立销售账号。
