import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { polygon } from "viem/chains";
import {
  ADDRESS_RETRY_COUNT,
  POLYMARKET_DATA_API_BASE_URL,
  PUSD_CONTRACT_ADDRESS,
  PUSD_DECIMALS,
  QUERY_CONCURRENCY
} from "./constants";
import type { AddressResult, LastTradeStatus, LpRewardsStatus, Position, TradeStatsStatus } from "./types";

type RawPosition = Record<string, unknown>;
type RawTrade = Record<string, unknown>;

const TRADE_PAGE_SIZE = 500;
const POSITION_PAGE_SIZE = 500;
const POSITION_MAX_PAGES = 20;
const RECENT_TRADE_PAGE_SIZE = 500;
const LP_REWARD_PAGE_SIZE = 500;
const LP_REWARD_MAX_PAGES = 100;
const RECENT_TRADE_MAX_PAGES = 3;

function readNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function readString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizePosition(position: RawPosition): Position {
  const market =
    readString(position.market) ||
    readString(position.title) ||
    readString(position.marketTitle) ||
    readString(position.slug, "Unknown market");
  const outcome =
    readString(position.outcome) ||
    readString(position.outcomeName) ||
    readString(position.asset, "Unknown outcome");

  return {
    market,
    outcome,
    size: readNumber(position.size),
    avgPrice: readNumber(position.avgPrice),
    currentValue: readNumber(position.currentValue),
    cashPnl: readNumber(position.cashPnl)
  };
}

async function withRetries<T>(task: () => Promise<T>, retries = ADDRESS_RETRY_COUNT): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

// /positions returns only 100 rows by default, so page through with limit/offset.
async function fetchAllPositions(address: string, signal: AbortSignal): Promise<RawPosition[]> {
  const all: RawPosition[] = [];

  for (let page = 0; page < POSITION_MAX_PAGES && !signal.aborted; page += 1) {
    const url = `${POLYMARKET_DATA_API_BASE_URL}/positions?user=${address}&limit=${POSITION_PAGE_SIZE}&offset=${page * POSITION_PAGE_SIZE}`;
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Polymarket Data API 返回 ${response.status}`);
    const json = (await response.json()) as unknown;
    const items = Array.isArray(json) ? (json as RawPosition[]) : [];
    all.push(...items);
    if (items.length < POSITION_PAGE_SIZE) break;
  }

  return all;
}

type TradeStatsFetchResult = {
  trades: RawTrade[];
  tradeStatsStatus: TradeStatsStatus;
  tradeStatsError?: string;
};

// Pages already fetched are kept when a later page fails, so a failed deep page
// degrades to "partial" stats instead of discarding everything.
async function fetchAllTradesSafely(address: string, signal: AbortSignal): Promise<TradeStatsFetchResult> {
  const all: RawTrade[] = [];
  let offset = 0;

  try {
    while (!signal.aborted) {
      const url = `${POLYMARKET_DATA_API_BASE_URL}/trades?user=${address}&limit=${TRADE_PAGE_SIZE}&offset=${offset}&takerOnly=false`;
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Trades API 返回 ${response.status}`);
      const page = (await response.json()) as unknown;
      const items = Array.isArray(page) ? (page as RawTrade[]) : [];
      all.push(...items);
      if (items.length < TRADE_PAGE_SIZE) break;
      offset += TRADE_PAGE_SIZE;
    }
  } catch (error) {
    if (signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.warn("Trades stats query failed", { address, fetchedCount: all.length, error: message });
    if (all.length === 0) {
      return { trades: all, tradeStatsStatus: "failed", tradeStatsError: message };
    }
    return {
      trades: all,
      tradeStatsStatus: "partial",
      tradeStatsError: `${message}，仅统计已获取的 ${all.length} 条交易`
    };
  }

  return { trades: all, tradeStatsStatus: "success" };
}

type LpRewardsFetchResult = {
  lpRewards: number;
  lpRewardsStatus: LpRewardsStatus;
  lpRewardsError?: string;
};

// Liquidity rewards are REWARD activity rows (maker rebates are a separate MAKER_REBATE type).
// /v2/activity uses cursor pagination, so it is not subject to the v1 offset cap.
async function fetchLiquidityRewards(address: string, signal: AbortSignal): Promise<LpRewardsFetchResult> {
  let lpRewards = 0;
  let fetchedCount = 0;
  let cursor: string | null = null;

  try {
    for (let page = 0; page < LP_REWARD_MAX_PAGES && !signal.aborted; page += 1) {
      const cursorParam: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const url = `${POLYMARKET_DATA_API_BASE_URL}/v2/activity?user=${address}&type=REWARD&limit=${LP_REWARD_PAGE_SIZE}${cursorParam}`;
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Activity API 返回 ${response.status}`);
      const json = (await response.json()) as { data?: unknown; pagination?: { has_more?: boolean; next_cursor?: string | null } };
      const items = Array.isArray(json.data) ? (json.data as RawTrade[]) : [];
      for (const item of items) {
        if (readString(item.type) === "REWARD") lpRewards += readNumber(item.usdc_size);
      }
      fetchedCount += items.length;
      cursor = json.pagination?.has_more && json.pagination.next_cursor ? json.pagination.next_cursor : null;
      if (!cursor) return { lpRewards, lpRewardsStatus: "success" };
    }
    return {
      lpRewards,
      lpRewardsStatus: "partial",
      lpRewardsError: `奖励记录超过 ${LP_REWARD_PAGE_SIZE * LP_REWARD_MAX_PAGES} 条，仅统计前 ${fetchedCount} 条`
    };
  } catch (error) {
    if (signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.warn("LP rewards query failed", { address, fetchedCount, error: message });
    if (fetchedCount === 0) return { lpRewards: 0, lpRewardsStatus: "failed", lpRewardsError: message };
    return { lpRewards, lpRewardsStatus: "partial", lpRewardsError: `${message}，仅统计已获取的 ${fetchedCount} 条` };
  }
}

async function fetchLatestTrade(address: string, signal: AbortSignal) {
  try {
    const { trades, urls } = await fetchRecentTrades(address, signal);
    if (trades.length === 0) {
      return { lastTradeStatus: "empty" as LastTradeStatus };
    }

    // Latest trade time uses /trades?takerOnly=false so maker and taker fills are included,
    // then takes the maximum timestamp from the returned trades instead of trusting the first item.
    const latest = findLatestTrade(trades);
    if (!latest.timestamp) {
      console.warn("Unable to parse latest trade timestamp", {
        address,
        requestUrls: urls,
        tradeCount: trades.length,
        maxTimestamp: latest.timestamp,
        firstFiveTradeTimes: trades.slice(0, 5).map((trade) => ({
          timestamp: trade.timestamp,
          createdAt: trade.createdAt,
          created_at: trade.created_at,
          time: trade.time,
          tradedAt: trade.tradedAt,
          transactionTime: trade.transactionTime,
          blockTimestamp: trade.blockTimestamp
        }))
      });
      return { lastTradeStatus: "empty" as LastTradeStatus };
    }

    return {
      lastTradeStatus: "success" as LastTradeStatus,
      lastTradeTimestamp: latest.timestamp,
      lastTradeTime: formatDateTime(latest.timestamp),
      lastTradeHash: latest.hash
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      lastTradeStatus: "failed" as LastTradeStatus,
      lastTradeError: error instanceof Error ? error.message : "最近交易查询失败"
    };
  }
}

async function fetchRecentTrades(address: string, signal: AbortSignal): Promise<{ trades: RawTrade[]; urls: string[] }> {
  const trades: RawTrade[] = [];
  const urls: string[] = [];

  for (let page = 0; page < RECENT_TRADE_MAX_PAGES && !signal.aborted; page += 1) {
    const offset = page * RECENT_TRADE_PAGE_SIZE;
    const url = `${POLYMARKET_DATA_API_BASE_URL}/trades?user=${address}&limit=${RECENT_TRADE_PAGE_SIZE}&offset=${offset}&takerOnly=false&sortBy=TIMESTAMP&sortDirection=DESC`;
    urls.push(url);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Trades API 返回 ${response.status}`);
    const json = (await response.json()) as unknown;
    const items = Array.isArray(json) ? (json as RawTrade[]) : [];
    trades.push(...items);
    if (items.length < RECENT_TRADE_PAGE_SIZE || trades.length >= RECENT_TRADE_PAGE_SIZE * RECENT_TRADE_MAX_PAGES) break;
  }

  return { trades: trades.slice(0, RECENT_TRADE_PAGE_SIZE * RECENT_TRADE_MAX_PAGES), urls };
}

function findLatestTrade(trades: RawTrade[]) {
  let timestamp: number | undefined;
  let hash: string | undefined;

  for (const trade of trades) {
    const tradeTimestamp = extractTradeTimestamp(trade);
    if (tradeTimestamp && (!timestamp || tradeTimestamp > timestamp)) {
      timestamp = tradeTimestamp;
      hash = readString(trade.transactionHash) || readString(trade.hash) || undefined;
    }
  }

  return { timestamp, hash };
}

function extractTradeTimestamp(trade: RawTrade) {
  const candidates = [
    trade.timestamp,
    trade.createdAt,
    trade.created_at,
    trade.time,
    trade.tradedAt,
    trade.transactionTime,
    trade.blockTimestamp
  ];

  for (const candidate of candidates) {
    const timestamp = normalizeTimestamp(candidate);
    if (timestamp) return timestamp;
  }
  return undefined;
}

function normalizeTimestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function formatDateTime(timestamp: number) {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function calcTradeStats(trades: RawTrade[]) {
  let tradeVolume = 0;
  const markets = new Set<string>();
  const months = new Set<string>();
  const days = new Set<string>();

  for (const trade of trades) {
    tradeVolume += readTradeVolume(trade);

    const conditionId =
      readString(trade.conditionId) ||
      readString(trade.market) ||
      readString(trade.marketId) ||
      readString(trade.slug);
    if (conditionId) markets.add(conditionId);

    const timestamp = extractTradeTimestamp(trade);
    if (timestamp) {
      const date = new Date(timestamp);
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      const day = String(date.getUTCDate()).padStart(2, "0");
      months.add(`${year}-${month}`);
      days.add(`${year}-${month}-${day}`);
    }
  }

  return {
    tradeVolume,
    marketCount: markets.size,
    activeMonths: months.size,
    activeDays: days.size
  };
}

function readTradeVolume(trade: RawTrade) {
  const direct = readNumber(trade.usdcSize) || readNumber(trade.amount) || readNumber(trade.value);
  if (direct) return direct;
  const size = readNumber(trade.size);
  const price = readNumber(trade.price);
  return size && price ? Math.abs(size * price) : 0;
}

export function createPortfolioQuerier(signal: AbortSignal) {
  const rpcUrl = process.env.NEXT_PUBLIC_POLYGON_RPC_URL;
  if (!rpcUrl) {
    throw new Error("缺少 NEXT_PUBLIC_POLYGON_RPC_URL，请先配置 Polygon RPC URL。");
  }

  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(rpcUrl)
  });

  async function queryAddress(address: string): Promise<AddressResult> {
    if (signal.aborted) {
      return createCanceledResult(address);
    }

    try {
      return await withRetries(async () => {
        if (signal.aborted) throw new DOMException("查询已取消", "AbortError");

        const [rawPositions, rawBalance, tradeStats, latestTrade, lpRewards] = await Promise.all([
          fetchAllPositions(address, signal),
          publicClient.readContract({
            address: PUSD_CONTRACT_ADDRESS,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address as `0x${string}`]
          }),
          fetchAllTradesSafely(address, signal),
          fetchLatestTrade(address, signal),
          fetchLiquidityRewards(address, signal)
        ]);

        const positions = rawPositions.map((item) => normalizePosition(item as RawPosition));
        const pusdBalance = Number(formatUnits(rawBalance, PUSD_DECIMALS));
        const positionsValue = positions.reduce((sum, position) => sum + position.currentValue, 0);
        const { tradeVolume, marketCount, activeMonths, activeDays } = calcTradeStats(tradeStats.trades);

        return {
          address,
          pusdBalance,
          positionsValue,
          totalValue: pusdBalance + positionsValue,
          positions,
          tradeVolume,
          marketCount,
          activeMonths,
          activeDays,
          tradeStatsStatus: tradeStats.tradeStatsStatus,
          tradeStatsError: tradeStats.tradeStatsError,
          ...lpRewards,
          ...latestTrade,
          status: "success",
          updatedAt: Date.now()
        };
      });
    } catch (error) {
      if (signal.aborted) {
        return createCanceledResult(address);
      }
      return {
        address,
        pusdBalance: 0,
        positionsValue: 0,
        totalValue: 0,
        positions: [],
        tradeVolume: 0,
        marketCount: 0,
        activeMonths: 0,
        activeDays: 0,
        lastTradeStatus: "failed",
        lastTradeError: "查询失败",
        status: "failed",
        error: error instanceof Error ? error.message : "未知错误",
        updatedAt: Date.now()
      };
    }
  }

  return { queryAddress };
}

export async function queryAddressesStreaming(
  addresses: string[],
  signal: AbortSignal,
  onResult: (result: AddressResult, completed: number) => void
) {
  const { queryAddress } = createPortfolioQuerier(signal);
  let cursor = 0;
  let completed = 0;

  async function worker() {
    while (cursor < addresses.length && !signal.aborted) {
      const address = addresses[cursor];
      cursor += 1;
      const result = await queryAddress(address);
      completed += 1;
      onResult(result, completed);
    }
  }

  const workerCount = Math.min(QUERY_CONCURRENCY, addresses.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (signal.aborted) {
    for (const address of addresses.slice(completed)) {
      completed += 1;
      onResult(createCanceledResult(address), completed);
    }
  }
}

export function createPendingResult(address: string, note?: string): AddressResult {
  return {
    address,
    note,
    pusdBalance: 0,
    positionsValue: 0,
    totalValue: 0,
    positions: [],
    tradeVolume: 0,
    marketCount: 0,
    activeMonths: 0,
    activeDays: 0,
    status: "pending",
    updatedAt: Date.now()
  };
}

function createCanceledResult(address: string): AddressResult {
  return {
    address,
    pusdBalance: 0,
    positionsValue: 0,
    totalValue: 0,
    positions: [],
    tradeVolume: 0,
    marketCount: 0,
    activeMonths: 0,
    activeDays: 0,
    lastTradeStatus: "failed",
    lastTradeError: "查询已取消",
    status: "canceled",
    error: "查询已取消",
    updatedAt: Date.now()
  };
}
