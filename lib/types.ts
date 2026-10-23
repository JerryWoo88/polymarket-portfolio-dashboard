export type QueryStatus = "pending" | "success" | "failed" | "canceled";
export type LastTradeStatus = "success" | "empty" | "failed";
export type TradeStatsStatus = "success" | "partial" | "failed";
export type LpRewardsStatus = "success" | "partial" | "failed";

export type StoredAddress = {
  address: string;
  batchId: string;
  createdAt: number;
  note?: string;
};

export type StoredBatch = {
  id: string;
  name: string;
  createdAt: number;
  importedCount: number;
};

export type Position = {
  market: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  cashPnl: number;
};

export type AddressResult = {
  address: string;
  note?: string;
  pusdBalance: number;
  positionsValue: number;
  totalValue: number;
  positions: Position[];
  tradeVolume: number;
  marketCount: number;
  activeMonths: number;
  activeDays: number;
  tradeStatsStatus?: TradeStatsStatus;
  tradeStatsError?: string;
  lpRewards?: number;
  lpRewardsStatus?: LpRewardsStatus;
  lpRewardsError?: string;
  lastTradeTime?: string;
  lastTradeTimestamp?: number;
  lastTradeHash?: string;
  lastTradeStatus?: LastTradeStatus;
  lastTradeError?: string;
  status: QueryStatus;
  error?: string;
  updatedAt: number;
};

export type QueryTotals = {
  totalValue: number;
  totalPusdBalance: number;
  totalPositionsValue: number;
  totalTradeVolume: number;
  totalLpRewards?: number;
  successCount: number;
  failedCount: number;
};

export type QuerySnapshot = {
  id: string;
  scope: string;
  createdAt: number;
  totals: QueryTotals;
  results: AddressResult[];
};

export type ImportAddressEntry = {
  address: string;
  note?: string;
};

export type ImportPreview = {
  validCount: number;
  duplicateCount: number;
  invalidCount: number;
  newCount: number;
  validAddresses: string[];
  validEntries: ImportAddressEntry[];
  invalidItems: string[];
};
