# 技能：邮箱验证（AfterShip email-verifier，本地运行）

> 不发信就判断一个邮箱是否真实存在：语法 → MX 记录 → SMTP 握手（`RCPT TO` 后立即断开，含 catch-all 探测）
> → 一次性 / 角色 / 免费邮箱检测 → 域名拼写纠错。核心是 [AfterShip/email-verifier](https://github.com/AfterShip/email-verifier)，
> chapi 把 `tools/email-verifier` 编译成本地程序按批调用（不需要 Docker），**用户在「设置 → 邮箱验证」勾选启用后才可用**。

## 何时使用
- 整理联系人/潜在客户名单，发邮件（或建 Gmail 草稿）前清洗无效地址。
- 用户问"这个邮箱是真的吗/还能用吗"。
- 从网页抓到的邮箱、猜出来的邮箱（如 `first.last@company.com`）需要确认。

## 如何使用
工具：`mcp__chapi__verify_email`
```
{ emails: ["a@x.com", "b@y.com"], saveTo?: "email-verify.json" }   // 每次最多 50 个
```
返回每行一个：`邮箱 → status（原因）`，外加汇总与注意事项；`saveTo` 会把验证器的完整原始 JSON 写进沙盘。

**更多地址（>50）**：分批调用，或写脚本调 chapi 的 HTTP 接口（每次 ≤200 个）：
```python
import os, requests
r = requests.post(f"{os.environ['CHAPI_SERVER_URL']}/api/email-verify",
                  json={"emails": batch}, timeout=3600)
r.raise_for_status(); data = r.json()   # {"results": [...], "notes": [...]}
```
后端已限制并发（3 个同时），别再自己并发猛刷——邮件服务器会把探测过快的 IP 拉黑。

## 怎么解读 status
| status | 含义 | 建议 |
|---|---|---|
| `safe` | SMTP 确认收件箱存在、可投递，且不是角色邮箱 | 可用 |
| `risky` | catch-all（域名全收或服务器不肯回答，无法确认个人）、收件箱已满、角色邮箱（info@/sales@）、一次性邮箱 | 标注风险，按用途决定 |
| `invalid` | 语法错 / 域名不存在或无 MX / 服务器明确拒收该地址 | 剔除 |
| `unknown` | SMTP 层没能确认（超时、连不上、被拦、DNS 出错） | **不要当成 invalid**，标为"未验证" |

其它字段：`suggestion` = 疑似拼写错误的修正（如 `gmial.com` → `gmail.com`），可以向用户确认；
`free` = 免费邮箱（gmail/qq/163 等），B2B 场景可据此区分个人邮箱与公司邮箱。
`disposable` 的名单里还收录了大量**仿冒拼写域名**（`gmial.com`、`hotmial.com`、`outlok.com`……被抢注用来截收误发邮件），
所以"一次性"也可能意味着用户把大厂域名拼错了——这种地址发出去会落到第三方手里，应向用户确认正确拼写。

## 已知限制（重要）
- **本机出站 25 端口被 ISP 封锁**（家用宽带普遍如此）：没配代理时 SMTP 步骤连不上，
  结果大多是 `unknown`，只有**语法 / MX / 一次性 / 角色 / 免费邮箱 / 拼写纠错**这几项可信。工具返回里会有"注意"说明。
  要做收件箱级验证，需在设置里填一个**开放 25 端口的 SOCKS5 代理**（可选再填 MAIL FROM / HELO，最好与代理出口 IP 的反向解析一致）。
- Gmail / Outlook / Yahoo 等大厂对 SMTP 探测越来越保守，即使有代理也可能 `unknown` 或 `risky`。
- 每个地址最多约 10–50 秒（连接 10 秒 + 每步 SMTP 10 秒）；50 个地址可能要几分钟，耐心等，别重复调用。
- 结果是**概率判断**，不是 100% 保证；交付时写明"验证方式与日期"。

## 失败回退
- 返回"邮箱验证未启用" → `ask_user` 请用户去「设置 → 邮箱验证」勾选启用并保存。
- 返回"邮箱验证程序未能编译" → 多半是没装 Go；请用户安装（Windows: `winget install GoLang.Go`）后重试。
  首次编译要下载 Go 依赖，需要能访问 proxy.golang.org。
- 仍有问题：看设置页的状态信息/日志，或服务端日志里的 `[email-verify]` 行。
