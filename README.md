# polymarket-portfolio-dashboard

一个本地优先的 Polymarket 多地址资产批量查询网页。用户可以分批导入 EVM 地址，地址库、最近查询结果和查询历史都保存在当前浏览器 IndexedDB，不需要私钥，不连接钱包，也不会上传到自建服务器数据库。

## 安装

```bash
npm install
```

## 配置 Polygon RPC

复制环境变量示例：

```bash
cp .env.example .env.local
```

然后在 `.env.local` 中配置：

```bash
NEXT_PUBLIC_POLYGON_RPC_URL=https://your-polygon-rpc.example
```

这个 RPC 只用于通过 `viem` 对 Polygon 上 pUSD ERC20 合约执行公开只读的 `balanceOf` 查询。

## 运行

```bash
npm run dev
```

打开终端显示的本地地址，通常是 `http://localhost:3000`。

## 构建

```bash
npm run lint
npm run build
```

## 部署到 Vercel

1. 将项目推送到 GitHub。
2. 在 Vercel 导入该仓库。
3. 在 Vercel 项目设置中添加环境变量 `NEXT_PUBLIC_POLYGON_RPC_URL`。
4. 部署即可。

## 使用网页

1. 在地址导入区粘贴 Polymarket / EVM 地址，地址可用换行、空格或逗号分隔。
2. 输入批次名称并点击“导入地址”。每批最多 300 个有效地址，可以多次分批导入。
3. 在查询控制区选择查询当前输入、选中批次或全部已保存地址。
4. 查询会以 10 并发执行，单个地址失败会重试 2 次，并且不会影响其他地址。
5. 查询全部地址时可以看到进度，例如 `580 / 1200`，也可以随时取消。
6. 总览区会统计全部当前结果的总资产、pUSD 余额、持仓市值、未实现 PnL、持仓数量、成功数和失败数。
7. 结果明细支持搜索、排序、CSV 导出；点击地址可以展开 positions 明细。

## 数据来源

- Polymarket Data API：`https://data-api.polymarket.com/positions?user={address}`
- Polygon RPC：读取 pUSD ERC20 `balanceOf`

所有请求都是公开只读请求。
