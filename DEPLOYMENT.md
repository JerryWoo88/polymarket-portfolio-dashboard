# Deployment Guide

This project is a client-side Next.js dashboard for querying public Polymarket and Polygon data. It does not require a private key, wallet connection, or a server database.

## Local Run

Install dependencies:

```powershell
cd E:\polymarket-portfolio-dashboard
npm install
```

Create `.env.local`:

```powershell
Set-Content .env.local "NEXT_PUBLIC_POLYGON_RPC_URL=https://polygon-rpc.com"
```

Start the development server:

```powershell
npm run dev
```

Open:

```text
http://localhost:3000
```

## Create a GitHub Repository and Push

Initialize Git if the folder is not already a repository:

```powershell
cd E:\polymarket-portfolio-dashboard
git init
git add .
git commit -m "Initial Polymarket portfolio dashboard"
```

Create an empty repository on GitHub, then connect and push:

```powershell
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/polymarket-portfolio-dashboard.git
git push -u origin main
```

Before pushing, confirm `.env.local`, `.env.local.txt`, `.vercel`, `node_modules`, and `.next` are not staged:

```powershell
git status --short
```

## Import the GitHub Repository into Vercel

1. Open [Vercel](https://vercel.com/).
2. Click **Add New** → **Project**.
3. Choose the GitHub repository.
4. Keep the framework preset as **Next.js**.
5. Configure the environment variable below before deploying.

## Vercel Environment Variable

Add this variable in **Project Settings** → **Environment Variables**:

```text
NEXT_PUBLIC_POLYGON_RPC_URL=https://polygon-rpc.com
```

Apply it to **Production**, **Preview**, and **Development** unless you intentionally want different RPC URLs per environment.

Important: variables starting with `NEXT_PUBLIC_` are exposed to browser JavaScript. Use only a public RPC URL here. Do not place private paid RPC keys, private API keys, wallet private keys, secrets, or server-only credentials in this variable.

## Recommended Vercel Settings

- Framework Preset: `Next.js`
- Install Command: `npm install`
- Build Command: `npm run build`
- Output Directory: leave empty / default
- Development Command: `npm run dev`
- Node.js Version: Vercel default for Next.js 16, or the latest supported LTS/runtime shown in Vercel

The app stores address batches, latest results, and query snapshots in the visitor's own browser IndexedDB. Vercel does not need a database for this project.

## Multi-User Local Data Isolation

This dashboard is intentionally local-first:

- Address batches are saved in the visitor's own browser IndexedDB.
- Latest query results are saved in the visitor's own browser IndexedDB.
- Query snapshots/history are saved in the visitor's own browser IndexedDB.
- The app does not use `localStorage` or `sessionStorage` for portfolio data.
- The app does not include API routes, server actions, a server database, server file writes, or third-party storage.
- Different users visiting the same Vercel URL do not see each other's imported addresses or query results.
- Wallet addresses are sent only to the public Polymarket Data API and the configured Polygon RPC URL for read-only queries. They are not stored on your Vercel server.

## Bind a Custom Domain

1. Open the Vercel project.
2. Go to **Settings** → **Domains**.
3. Add your domain, for example `dashboard.example.com`.
4. Follow Vercel's DNS instructions.
5. For an apex domain, configure the DNS record Vercel recommends.
6. For a subdomain, add the CNAME record Vercel recommends.
7. Wait for DNS verification and SSL certificate provisioning to complete.

## Post-Deployment Verification

After deployment, open the Vercel URL and verify:

1. The page loads without a blank screen.
2. The local storage notice is visible.
3. You can paste a valid EVM address.
4. You can import a batch.
5. You can query the current input or selected batch.
6. The progress bar updates while querying.
7. Results show pUSD balance, positions value, total value, historical trade volume, market count, active months, and active days.
8. Refreshing the page restores local batches and latest results from IndexedDB.

## Common Troubleshooting

### Missing RPC URL

Symptom: query fails with a message about `NEXT_PUBLIC_POLYGON_RPC_URL`.

Fix: add `NEXT_PUBLIC_POLYGON_RPC_URL` in Vercel environment variables, then redeploy.

### RPC Requests Fail or Are Rate Limited

Symptom: many addresses fail, or pUSD balance stays unavailable.

Fix: use a reliable public Polygon RPC endpoint. If you use a paid RPC provider, remember that a `NEXT_PUBLIC_` URL is visible in the browser and should be restricted by provider-side domain allowlists and rate limits.

### Polymarket API Requests Fail

Symptom: positions or activity data fails for many addresses.

Fix: check browser devtools Network requests to `https://data-api.polymarket.com`. The API is a public third-party dependency and can be temporarily unavailable or rate limited.

### Data Disappears on Another Browser

This is expected. Address batches and query results are stored only in the current browser's IndexedDB. They are not synced between devices, browsers, or users.

### Environment Variable Changed but App Still Uses Old Value

Redeploy the Vercel project after changing environment variables. `NEXT_PUBLIC_` variables are embedded during build.

### Build Fails on Vercel

Run locally:

```powershell
npm run lint
npm run build
```

If local build passes but Vercel fails, check Vercel's Node.js version, install logs, and environment variable configuration.
