# dsh-auth-gateway

给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) Web UI 加一层「首次访问自设密码」的认证网关，让它可以安全地暴露到公网 IP + 端口。

```
浏览器 ──HTTPS(自签)──> 网关 ──HTTP(回环)──> DSH :3299
                          │
                          ├─ 无 cookie → 登录页 / 首次设置页
                          └─ 有 cookie → 原样转发（含 WebSocket）
```

只输一次密码，进去就是 DSH 界面，不会在 DSH 那边再要求你贴 token。

## 为什么需要它

DSH Web 出于安全只允许绑 `127.0.0.1`，而且内置的 `?token=` 机制有两个问题：

1. **token 每个进程随机生成**，重启就变，没法固定写进书签或客户端。
2. **它只防「误访问」，不防「猜」**——没有密码、没有失败限流，也没有改密码的入口。

这个网关补上这些：自己的密码（scrypt）、有失败限流、有登出，同时保留 DSH 原有的全部安全围栏。

## 它是怎么做到不用二次登录的

DSH 启动时生成一个仅存在于内存的 `launchToken`，只有把它拼到 URL 上才能换取 DSH 的会话 cookie。网关在另一个进程，拿不到它。

但 DSH 的 **cookie 签名密钥是持久化的**（在 `~/.dsh/.credentials.yaml` 里），而 cookie 格式是固定的：

```
dsh-auth-<base64url(sha256(authority))> = v1.<base64url(payload)>.<base64url(HMAC-SHA256(key, body))>
payload = { version: 1, authority, issuedAt, expiresAt }   // 毫秒
key     = base64url 解码后的 32 字节
```

所以网关直接读那把密钥、自己签一张 DSH 认的 cookie 一并下发。安全边界没有被削弱——「谁能进」的决策集中到了网关这一层，而 DSH 的 Host / Origin / CSRF 围栏**依然照旧生效**（那些检查和 cookie 是两回事）。

不想用这个特性就加 `--no-sso`，代价是登录后要手动把 DSH 打印的 token URL 贴一次。

## 安装

需要 Node.js ≥ 20，以及 `openssl`（自签证书用；已有证书可跳过）。

```bash
git clone https://github.com/dolou12388/dsh-auth-gateway.git
cd dsh-auth-gateway
```

无第三方依赖，不用 `npm install`。

## 快速开始

```bash
# 1. 先用网关同款参数启动 DSH（trusted-host 必须写浏览器看到的地址）
dsh web --host 127.0.0.1 --port 3299 --trusted-host 203.0.113.10:8443

# 2. 启动网关
node src/index.js --port 8443 --public-host 203.0.113.10
```

浏览器打开 `https://203.0.113.10:8443`——自签证书会警告，选「继续访问」，然后设置密码。

## 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--port <n>` | `8443` | 监听端口 |
| `--host <addr>` | `0.0.0.0` | 监听地址 |
| `--upstream <url>` | `http://127.0.0.1:3299` | DSH 地址（仅支持 http，同机无需加密） |
| `--data-dir <path>` | `~/.dsh-auth-gateway` | 凭据、会话密钥、证书存放目录 |
| `--dsh-home <path>` | `$DSH_HOME` 或 `~/.dsh` | 读 DSH 配置的位置（SSO 和模型配置用） |
| `--profile <name>` | `web` | 要配置的 DSH profile |
| `--public-host <h>` | 自动探测 | 证书 CN / 日志里展示的地址 |
| `--cert` / `--key` | `<data-dir>/cert.pem` 等 | 自定义证书 |
| `--http` | 关 | 明文 HTTP（**密码会明文过网**，仅限本机/可信内网） |
| `--trust-proxy` | 关 | 信任 `X-Forwarded-For`（前面还有一层代理时才开） |
| `--no-sso` | 关 | 不自动签发 DSH cookie |

环境变量：`DSH_GATEWAY_HOME`（等同 `--data-dir`）、`DSH_HOME`（等同 `--dsh-home`）。

## 网页里配模型

登录后，如果 DSH 还没有可用的模型配置，网关会自动把你引到 **`/__gateway/config`**——不用登进 DSH 摸设置菜单，也不用碰命令行。

这个页面上做三件事：

1. 填 **API 地址**（OpenAI 兼容的 Base URL，例如 `https://api.example.com/v1`）和 **API Key**
2. 点「拉取模型列表」——网关会带着你的 Key 去请求 `<baseURL>/models`
3. 从下拉里选一个默认模型，点「保存并生效」

保存后**立即生效**，不用重启 DSH：网关写的是 DSH 的 patch 文件，而 DSH 对它有 HMR 监听。

写下去的内容分别落在两个地方：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml   ← provider 定义 + 默认模型
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      custom:
        displayName: 自定义
        apiKeyEnv: DSH_GW_API_KEY
        api: openai-completions
        baseURL: https://api.example.com/v1
        models:
          - id: deepseek-v4-1-flash
            name: deepseek-v4-1-flash
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: custom
    model: deepseek-v4-1-flash
```

```yaml
# ~/.dsh/.credentials.yaml   ← Key 单独存，只追加这一个 ref
version: 1
refs:
  DSH_GW_API_KEY: sk-...
records:
  client-connection/browser-session: ...   # 原有内容完整保留，不会掉线
```

API Key 输入框留空表示「沿用已保存的值」，换模型时不必重输。

## 部署为 systemd 服务

`/etc/systemd/system/dsh-web.service`：

```ini
[Unit]
Description=DSH Web
After=network-online.target

[Service]
Type=simple
User=root
Environment=HOME=/root
Environment=NODE_OPTIONS=--max-old-space-size=768
ExecStart=/usr/bin/dsh web --host 127.0.0.1 --port 3299 --no-open \
    --trusted-host 203.0.113.10:8443
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/dsh-auth-gateway.service`：

```ini
[Unit]
Description=DSH Auth Gateway
After=network-online.target dsh-web.service

[Service]
Type=simple
User=root
Environment=HOME=/root
Environment=NODE_OPTIONS=--max-old-space-size=256
WorkingDirectory=/opt/dsh-auth-gateway
ExecStart=/usr/bin/node /opt/dsh-auth-gateway/src/index.js \
    --port 8443 --host 0.0.0.0 \
    --upstream http://127.0.0.1:3299 \
    --data-dir /root/.dsh-auth-gateway \
    --public-host 203.0.113.10
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now dsh-web dsh-auth-gateway
journalctl -u dsh-auth-gateway -f
```

首次启动会自动生成自签证书（10 年有效，SAN 按 IP/DNS 自动选对）。

## 安全设计

| 环节 | 做法 |
|---|---|
| 密码存储 | scrypt（N=16384, r=8, p=1, 64 字节），参数随记录快照，未来调参不影响旧密码 |
| 密码比较 | `timingSafeEqual`，先挡超长输入避免拖慢进程 |
| 会话 | HMAC-SHA256 签名 cookie，密钥持久化 → 重启不掉线 |
| 爆破防护 | 单 IP 15 分钟内 8 次失败即锁，锁定期内**正确密码也被拒** |
| 凭据文件 | 原子写入（临时文件 + rename）、`0600` |
| 登录页 | 无外部依赖、`x-frame-options: DENY`、`referrer-policy: no-referrer` |
| 跳转 | `next` 只接受站内相对路径，挡掉 `//evil.com` 这类开放重定向 |
| WebSocket | `upgrade` 事件独立校验会话，未认证直接 401 |

DSH 侧原有的围栏全部保留并通过实测：伪造 `Host` → 403、`sec-fetch-site: cross-site` → 403、外站 `Origin` → 403。

## 两个必须做对的配置

**1. 不改写 Host 头。** DSH 把 authority 签进 cookie，并用 `Host` 做 DNS-rebinding 围栏。代理改写 Host 会导致 cookie 立即失效 + API 全 403。

**2. `--trusted-host` 要填浏览器看到的 authority。** 漏了这步的症状很隐蔽：**首页能正常打开，但所有 API 返回 403**，界面上表现为「什么都点不动」。

## 已知限制

- **单用户**。没有多账号、没有权限分级，就是一个人用。
- 首次设置密码是「先到先得」——所以**装完立刻去设密码**，别让服务裸奔在公网上等。
- 自签证书会让浏览器警告，且 `curl` 需要 `-k`。要彻底消除警告得用真域名 + Let's Encrypt。
- 忘了密码只能删掉 `<data-dir>/credential.json` 重启，重新进入首次设置。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/index.js` | 主入口、路由分流、限流、TLS/HTTP 启动、upgrade 鉴权 |
| `src/credentials.js` | scrypt 密码存储、首设、校验、改密 |
| `src/session.js` | 网关自己的 HMAC 签名 cookie |
| `src/dsh-session.js` | 读 DSH 签名密钥，代签 DSH 会话 cookie（SSO） |
| `src/dsh-config.js` | 写 DSH 的 provider / Key / 默认模型，拉取上游模型列表 |
| `src/config-page.js` | 模型配置页（单文件内联） |
| `src/login-page.js` | 单文件内联登录/设置页，暗色适配 |
| `src/proxy.js` | 反向代理，Host 透传 + WebSocket 转发 |
| `src/tls.js` | 调 openssl 生成自签证书，SAN 区分 IP/DNS |

## 测试

```bash
node test/config-roundtrip.mjs   # 配置读写的往返与幂等
node test/dsh-parses.mjs         # 让 DSH 亲自解析写出的配置
node test/mock-upstream.mjs      # 用假上游验拉取模型列表
node test/live-dsh.mjs           # 全链路：配好 → DSH 真发请求并收到回复
```
