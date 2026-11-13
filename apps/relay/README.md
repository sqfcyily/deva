# Deva 手机网页中转

把手机与电脑上的 Deva 之间的 WebSocket 帧原样互转，让手机在任何网络下都能连到家里 / 办公室那台没有公网 IP 的电脑。中转不解析内容，只按「桌面 id」路由。

- 运行在 Cloudflare Workers + Durable Objects（免费套餐即可；SQLite 后端的 DO）。
- 同一套中转逻辑以后也可以用 Node 自建（协议见 `apps/desktop/src/shared/remote-web.ts`）。

## 部署

```bash
# 1. 构建手机网页（产物 apps/desktop/out/mobile）
cd apps/desktop && pnpm build:mobile

# 2. 登录 Cloudflare 并部署（deploy 前会自动把网页复制到 public/）
cd ../relay
pnpm wrangler login
pnpm deploy
```

部署完成后会得到一个 `https://deva-relay.<你的子域>.workers.dev` 地址（也可以在 Cloudflare 控制台绑定自己的域名）。

## 在 Deva 里使用

1. 电脑端 Deva →「机器人」→ 添加「手机网页」。
2. 在「经中转访问」里填上面的地址并开启；状态变为「可用」即表示桌面端已连上中转。
3. 点「显示二维码」，用手机扫码即可。

## 工作方式

- 桌面端连 `wss://<中转>/desk/<桌面 id>`，带 `Authorization: Bearer <桌面密钥>`。密钥在桌面 id 首次连接时登记（只存哈希），之后必须一致——别的电脑拿不到密钥就冒充不了这个桌面 id。
- 手机连 `wss://<中转>/d/<桌面 id>/ws`，页面从中转的静态资源加载（`https://<中转>/#d=<桌面 id>`）。
- 每个桌面 id 一个 Durable Object，两头都是可休眠的 WebSocket：没有消息经过时不计费。

## 注意

- TLS 在 Cloudflare 终止，中转理论上能看到明文；桌面端与手机之间目前没有端到端加密。自用或小范围分享足够，公开运营前请评估。
- 本地调试：`pnpm dev` 起 `http://127.0.0.1:8787`，Deva 里中转地址填它即可（桌面端会自动换成 ws://）。
