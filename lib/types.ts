export type QueryStatus = "pending" | "success" | "failed" | "canceled";

export type StoredAddress = {
  address: string;
  batchId: string;
  createdAt: number;
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
  pusdBalance: number;
  positionsValue: number;
  totalValue: number;
  positions: Position[];
  // trading stats from /activity
  tradeVolume: number;
  marketCount: number;
  activeMonths: number;
  activeDays: number;
  status: QueryStatus;
  error?: string;
  updatedAt: number;
};

export type QueryTotals = {
  totalValue: number;
  totalPusdBalance: number;
  totalPositionsValue: number;
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

export type ImportPreview = {
  validCount: number;
  duplicateCount: number;
  invalidCount: number;
  newCount: number;
  validAddresses: string[];
  invalidItems: string[];
};
