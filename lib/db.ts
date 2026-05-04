"use client";

import Dexie, { type Table } from "dexie";
import type { AddressResult, QuerySnapshot, StoredAddress, StoredBatch } from "./types";

class PortfolioDatabase extends Dexie {
  addresses!: Table<StoredAddress, string>;
  batches!: Table<StoredBatch, string>;
  latestResults!: Table<AddressResult, string>;
  querySnapshots!: Table<QuerySnapshot, string>;

  constructor() {
    super("polymarket_portfolio_dashboard");
    this.version(1).stores({
      addresses: "&address, batchId, createdAt",
      batches: "&id, createdAt",
      latestResults: "&address, status, updatedAt",
      querySnapshots: "&id, createdAt"
    });
  }
}

export const db = new PortfolioDatabase();

export async function clearLocalDatabase() {
  await db.transaction("rw", db.addresses, db.batches, db.latestResults, db.querySnapshots, async () => {
    await Promise.all([
      db.addresses.clear(),
      db.batches.clear(),
      db.latestResults.clear(),
      db.querySnapshots.clear()
    ]);
  });
}
