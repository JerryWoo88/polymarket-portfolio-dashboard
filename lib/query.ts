import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { polygon } from "viem/chains";
import {
  ADDRESS_RETRY_COUNT,
  POLYMARKET_DATA_API_BASE_URL,
  PUSD_CONTRACT_ADDRESS,
  PUSD_DECIMALS,
  QUERY_CONCURRENCY
} from "./constants";
import type { AddressResult, Position } from "./types";

type RawPosition = Record<string, unknown>;
type RawActivity = Record<string, unknown>;

const ACTIVITY_PAGE_SIZE = 500;

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

async function fetchAllTradeActivity(address: string, signal: AbortSignal): Promise<RawActivity[]> {
  const all: RawActivity[] = [];
  let offset = 0;

  while (!signal.aborted) {
    const url = `${POLYMARKET_DATA_API_BASE_URL}/activity?user=${address}&type=TRADE&limit=${ACTIVITY_PAGE_SIZE}&offset=${offset}`;
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Activity API 返回 ${response.status}`);
    const page = (await response.json()) as unknown;
    const items = Array.isArray(page) ? (page as RawActivity[]) : [];
    all.push(...items);
    if (items.length < ACTIVITY_PAGE_SIZE) break;
    offset += ACTIVITY_PAGE_SIZE;
  }

  return all;
}

function calcActivityStats(activities: RawActivity[]) {
  let tradeVolume = 0;
  const markets = new Set<string>();
  const months = new Set<string>();
  const days = new Set<string>();

  for (const activity of activities) {
    tradeVolume += readNumber(activity.usdcSize);

    const conditionId = readString(activity.conditionId);
    if (conditionId) markets.add(conditionId);

    const timestamp = readNumber(activity.timestamp);
    if (timestamp > 0) {
      const date = new Date(timestamp * 1000);
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

        const [positionsResponse, rawBalance, activities] = await Promise.all([
          fetch(`${POLYMARKET_DATA_API_BASE_URL}/positions?user=${address}`, { signal }),
          publicClient.readContract({
            address: PUSD_CONTRACT_ADDRESS,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address as `0x${string}`]
          }),
          fetchAllTradeActivity(address, signal)
        ]);

        if (!positionsResponse.ok) {
          throw new Error(`Polymarket Data API 返回 ${positionsResponse.status}`);
        }

        const positionsJson = (await positionsResponse.json()) as unknown;
        const rawPositions = Array.isArray(positionsJson) ? positionsJson : [];
        const positions = rawPositions.map((item) => normalizePosition(item as RawPosition));
        const pusdBalance = Number(formatUnits(rawBalance, PUSD_DECIMALS));
        const positionsValue = positions.reduce((sum, position) => sum + position.currentValue, 0);
        const { tradeVolume, marketCount, activeMonths, activeDays } = calcActivityStats(activities);

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

export function createPendingResult(address: string): AddressResult {
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
    status: "canceled",
    error: "查询已取消",
    updatedAt: Date.now()
  };
}
