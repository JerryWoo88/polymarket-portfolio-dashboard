import type { AddressResult, QueryTotals } from "./types";

export function formatUsd(value: number) {
  const amount = Number.isFinite(value) ? value : 0;
  const fractionDigits = Math.abs(amount) >= 1 ? 2 : 6;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.abs(amount) >= 1 ? 2 : 0,
    maximumFractionDigits: fractionDigits
  }).format(amount);
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 6
  }).format(Number.isFinite(value) ? value : 0);
}

export function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function emptyTotals(): QueryTotals {
  return {
    totalValue: 0,
    totalPusdBalance: 0,
    totalPositionsValue: 0,
    totalTradeVolume: 0,
    totalLpRewards: 0,
    successCount: 0,
    failedCount: 0
  };
}

export function calculateTotals(results: AddressResult[]): QueryTotals {
  return results.reduce<QueryTotals>((totals, result) => {
    if (result.status === "success") {
      totals.totalValue += result.totalValue;
      totals.totalPusdBalance += result.pusdBalance;
      totals.totalPositionsValue += result.positionsValue;
      totals.totalTradeVolume += Number.isFinite(result.tradeVolume) ? result.tradeVolume : 0;
      totals.totalLpRewards = (totals.totalLpRewards ?? 0) + (Number.isFinite(result.lpRewards) ? result.lpRewards ?? 0 : 0);
      totals.successCount += 1;
    } else if (result.status === "failed") {
      totals.failedCount += 1;
    }
    return totals;
  }, emptyTotals());
}

export function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const csv = rows
    .map((row) =>
      row
        .map((cell) => {
          const value = String(cell ?? "");
          return /[",\n]/.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
        })
        .join(",")
    )
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
