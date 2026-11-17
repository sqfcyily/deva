# Deva 手机版中转

把手机与电脑上的 Deva 之间的 WebSocket 帧原样互转，让手机在任何网络下都能连到家里或办公室那台没有公网 IP 的电脑。手机网页本身也由中转托管。

- 中转只按「桌面 id」路由，不解析内容。手机与电脑之间是**端到端加密**的（X25519 + ChaCha20-Poly1305，见 `apps/desktop/src/shared/remote-crypto.ts`），中转只看得到握手公钥和密文。
- 运行在 Cloudflare Workers + Durable Objects 上，免费套餐即可（使用 SQLite 后端的 DO）。
- 电脑端「连接方式」选「远程」时，默认用官方中转（`apps/desktop/src/shared/remote-web.ts` 的 `OFFICIAL_RELAY_URL`）；也可以部署自己的中转，在配置文件里改地址（见下文「自建中转」）。
- 不使用 Cloudflare 时，可以把 Node.js 版（`apps/relay-node`，协议相同）部署在自己的服务器上，见其 README。

## 部署

在项目根目录执行：

```bash
pnpm relay:login      # 首次：登录 Cloudflare（浏览器里确认终端显示的验证码）
pnpm relay:deploy     # 构建手机网页、复制到中转的静态资源并部署
```

登录用的是设备码方式（`wrangler login --device`）：终端会显示一个网址和验证码，浏览器打开后核对验证码并授权即可，不依赖本机的 `localhost:8976` 回调（开着代理或 VPN 时那个回调常常连不上）。

部署完成后会得到 `https://deva-relay.<你的子域>.workers.dev`，也可以在 Cloudflare 控制台绑定自己的域名。注意：workers.dev 在中国大陆通常无法访问，面向国内用户请绑定自己的域名。

- **官方中转**：把这个地址写进 `OFFICIAL_RELAY_URL`，再发布新版 Deva。
- **自建中转**：在配置文件里改，见下一节。

手机网页随中转一起部署。

## 自建中转

中转地址（以及局域网直连的端口）不在界面上修改，改配置文件 `~/.deva/config.json`（Windows 为 `%USERPROFILE%\.deva\config.json`）：

1. 先在电脑端左下角「手机」里添加「Deva 手机版」，配置文件里才会有对应的一项。
2. **退出 Deva**。Deva 运行时会整份重写配置文件，开着改会被覆盖。
3. 在 `remote.bots` 里找到 `"platform": "web"` 的那一项，把 `settings.relayUrl` 改成自己的中转地址：

   ```json
   {
     "remote": {
       "bots": [
         {
           "platform": "web",
           "settings": {
             "relayUrl": "https://relay.example.com"
           }
         }
       ]
     }
   }
   ```

   只改 `relayUrl` 这一个字段，同一项里的其他字段保持原样。留空（`""`）就是用官方中转。
   局域网直连的端口在同一处的 `settings.port`（默认 17800，可改为 1024–65535 之间的值）。
4. 重新打开 Deva。

换地址或端口后，之前经旧地址连接的手机需要重新扫码。手机网页与电脑端的协议版本（`WEB_PROTOCOL_VERSION`）不一致时，手机会提示刷新页面或更新 Deva，所以协议升级时要同时重新部署中转。

## 工作方式

- 电脑端连 `wss://<中转>/desk/<桌面 id>`，带 `Authorization: Bearer <桌面密钥>`。密钥在桌面 id 首次连接时登记（只存哈希），之后必须一致，别的电脑拿不到密钥就冒充不了这个桌面 id。
- 手机连 `wss://<中转>/d/<桌面 id>/ws`，页面从中转的静态资源加载。扫码地址形如 `https://<中转>/#d=<桌面 id>&p=<一次性配对票据>`，# 后面的内容不会发给中转。
- 每个桌面 id 对应一个 Durable Object，两头都用可休眠的 WebSocket，没有消息经过时不计费。
- 推送通知由电脑端直接发给手机浏览器的推送服务（Web Push），不经过中转。

## 本地调试

在项目根目录执行 `pnpm relay:dev`，会起 `http://127.0.0.1:8787`。按上一节把 `relayUrl` 改成这个地址，电脑端会自动换成 ws://。

在 `apps/relay` 目录里直接执行时要写 `pnpm run deploy`：`pnpm deploy` 是 pnpm 自带的命令，不会执行这里的部署脚本。
