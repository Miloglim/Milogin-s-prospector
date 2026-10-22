# Navigator 本机外部入口

## 当前拓扑

```text
外部用户
  -> https://rates-office.47.96.159.26.sslip.io
  -> 阿里云 Caddy :443
  -> 阿里云回环 127.0.0.1:18795
  -> SSH 反向隧道
  -> 本机 Navigator 127.0.0.1:8795
```

本机中心与 Navigator 的原有端口不变。阿里云 Caddy 配置文件位于 `/opt/logistics-api/releases/20261021T083709Z/Caddyfile`，新入口加入前备份为同目录 `Caddyfile.before-office-tunnel-20261022T145500+0800`。

## 安全边界

- 服务器专用账号为 `navigator-tunnel`，无登录 shell。
- 专用公钥只允许监听服务器回环 `127.0.0.1:18795`；不能执行普通服务器命令或其他端口转发。
- 家庭或公司路由器不开放 Navigator 入站端口。
- Windows 计划任务名为 `Milogin Navigator Office Tunnel`，运行 [守护脚本](<D:/Agent Basement/Milogin-s-prospector/scripts/navigator-office-tunnel.ps1>) 的安装副本 `%LOCALAPPDATA%\Milogin\navigator-office-tunnel.ps1`。
- SSH 正常退出或连接断开后，守护脚本等待 10 秒自动重连；日志位于 `%LOCALAPPDATA%\Milogin\Logs\navigator-office-tunnel.log`。

## 检查与恢复

```powershell
Get-ScheduledTask -TaskName 'Milogin Navigator Office Tunnel'
Get-ScheduledTaskInfo -TaskName 'Milogin Navigator Office Tunnel'
Invoke-RestMethod 'https://rates-office.47.96.159.26.sslip.io/api/health/live'
```

如果健康检查失败，先确认本机 `8795`、电脑联网和 Windows 登录状态，再停止并启动同名计划任务。服务器端可检查 `ss -ltnp | grep 18795`，不直接开放该端口。

已验证直接结束隧道 `ssh.exe` 后入口短暂不可用，守护脚本随后自动建立新进程并恢复健康，无需人工重启任务。

## 已知边界

- 本机、网络或登录会话离线时，外部入口立即不可用；这是过渡方案，不是最终高可用生产部署。
- 当前本机 Navigator 仍以本机中心为身份源。外部同事使用 Navigator 本地账号，不自动使用服务器中心单点登录。
- 该入口不应绕过 Navigator 自身账号权限。管理员账号只发给授权管理员，普通分公司人员使用独立销售账号。
