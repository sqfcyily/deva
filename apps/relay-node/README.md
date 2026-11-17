# Deva 手机版中转（Node.js 版）

把手机与电脑上的 Deva 之间的 WebSocket 帧原样互转，协议与 Cloudflare 版（`apps/relay`）完全相同。部署在自己的服务器上，不受 Workers 每日请求额度限制，同时托管手机网页。

- 中转只按桌面 id 配对、转发密文，不解析内容（端到端加密见 `apps/desktop/src/shared/remote-crypto.ts`）。
- 配对状态保存在进程内存中，同一个地址后面只能运行一个实例。
- 不做按 IP 限流。放在 Cloudflare 后面时由 WAF 速率限制规则负责；直接对外提供服务时，请在防火墙或反向代理上限流。

## 构建

在项目根目录执行：

```bash
pnpm relay-node:build
```

产物在 `apps/relay-node/dist/`：

| 文件 | 说明 |
|---|---|
| `relay.cjs` | 中转程序，已打包全部依赖，服务器上无需 `npm install` |
| `public/` | 手机网页 |
| `deva-relay.service` | systemd 服务示例 |

手机网页与电脑端的协议版本（`WEB_PROTOCOL_VERSION`）须一致，协议升级后要重新构建并部署。

## 运行

需要 Node.js 20 或以上。

```bash
node relay.cjs
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | 全部地址 | 监听地址 |
| `DATA_DIR` | 工作目录下的 `data` | 桌面登记文件所在目录 |
| `PUBLIC_DIR` | `relay.cjs` 同目录下的 `public` | 手机网页目录；不存在时只作中转使用 |
| `TLS_CERT` / `TLS_KEY` | 无 | 证书与私钥路径（PEM）。设置后提供 HTTPS，两者须同时设置 |

`GET /healthz` 返回 `ok`，可用于监控。

本地调试：构建后在项目根目录执行 `pnpm relay-node:start`，数据存放在 `apps/relay-node/data/`。

## 部署到 Linux 服务器（systemd）

1. 创建运行用户和目录：

   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin deva-relay
   sudo mkdir -p /opt/deva-relay/data
   ```

2. 把 `dist/` 中的全部内容上传到服务器的 `/opt/deva-relay/`，然后设置数据目录的属主：

   ```bash
   sudo chown -R deva-relay:deva-relay /opt/deva-relay/data
   ```

3. 安装并启动服务。先按实际情况修改服务文件中的 node 路径（`which node`）与环境变量：

   ```bash
   sudo cp /opt/deva-relay/deva-relay.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now deva-relay
   journalctl -u deva-relay -f
   ```

**升级**：替换 `relay.cjs` 和 `public/` 后执行 `sudo systemctl restart deva-relay`，不要改动 `data/`。重启期间电脑和手机会自动重连。

## 让电脑使用这台中转

按 `apps/relay/README.md`「自建中转」一节修改 `relayUrl`：

- 直连测试：`http://<服务器 IP>:8787`（防火墙须放行该端口）。手机网页可以正常使用，但 HTTP 页面下浏览器不提供推送通知和「添加到主屏幕」，正式使用请配置 HTTPS。
- 正式使用：`https://<域名>`。

换地址后，之前经旧地址连接的手机需要重新扫码。

## 放在 Cloudflare 代理后面

1. 添加 DNS 记录指向服务器并开启代理（橙色云）。经代理的普通请求不计入 Workers 的请求额度。
2. SSL/TLS 加密模式选「完全（严格）」（Full (strict)）。在「源服务器」（Origin Server）页面创建 Origin CA 证书，保存为 PEM 文件后配置到 `TLS_CERT` / `TLS_KEY`，`PORT` 设为 `443`（服务文件中有对应的注释行）。
3. 服务器防火墙的 443 端口只放行 Cloudflare 的 IP 段（<https://www.cloudflare.com/ips/>），避免绕过 Cloudflare 直接访问。
4. 服务器位于中国大陆时，域名须完成 ICP 备案，否则云厂商会拦截未备案域名的访问。

沿用 `m.deva.chat` 时有两种接法：

- **全部交给服务器**：解除 Worker 上的 `m.deva.chat` 自定义域，DNS 记录改为指向服务器。网页与中转都由本程序提供。
- **网页留在 Worker**：把 `m.deva.chat` 从 Worker 的「自定义域」改为「路由」（`m.deva.chat/*`），DNS 记录指向服务器，再为 `m.deva.chat/d/*` 与 `m.deva.chat/desk/*` 添加不指定 Worker 的路由，这两类请求即由服务器处理。

两种接法下，电脑和手机端都不需要修改。

## 数据

`data/desks.json` 记录桌面 id 与密钥的 SHA-256，用于防止别的电脑冒用桌面 id，请定期备份。文件损坏时程序拒绝启动，修复或删除后再启动；删除后，各电脑在下次连接时重新登记。
