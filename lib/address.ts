import { getAddress, isAddress } from "viem";
import { MAX_IMPORT_PER_BATCH } from "./constants";
import type { ImportAddressEntry, ImportPreview, StoredAddress } from "./types";

const ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}/g;

export function extractAddressCandidates(input: string) {
  const matches = input.match(ADDRESS_PATTERN);
  if (matches) return matches;
  return input
    .split(/[\s,;，；|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseAddressEntries(input: string): { entries: ImportAddressEntry[]; invalid: string[] } {
  const entries: ImportAddressEntry[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const matches = Array.from(line.matchAll(ADDRESS_PATTERN));
    if (matches.length === 0) {
      for (const candidate of line.split(/[\s,;，；|]+/).filter(Boolean)) {
        if (!isAddress(candidate)) invalid.push(candidate);
      }
      continue;
    }

    if (matches.length > 1) {
      for (const match of matches) {
        addEntry(match[0], "", entries, seen);
      }
      continue;
    }

    const rawAddress = matches[0][0];
    const addressEnd = (matches[0].index ?? 0) + rawAddress.length;
    const note = line
      .slice(addressEnd)
      .replace(/^[\s,;，；|:：-]+/, "")
      .trim();
    addEntry(rawAddress, note, entries, seen);
  }

  return { entries, invalid };
}

function addEntry(rawAddress: string, note: string, entries: ImportAddressEntry[], seen: Set<string>) {
  if (!isAddress(rawAddress)) return;
  const address = getAddress(rawAddress);
  const key = address.toLowerCase();
  if (seen.has(key)) return;
  entries.push({ address, note: note || undefined });
  seen.add(key);
}

export function normalizeAddresses(input: string) {
  const { entries, invalid } = parseAddressEntries(input);
  return { valid: entries.map((entry) => entry.address), invalid };
}

export function buildImportPreview(input: string, existing: StoredAddress[]): ImportPreview {
  const { entries, invalid } = parseAddressEntries(input);
  const existingSet = new Set(existing.map((item) => item.address.toLowerCase()));
  const limitedEntries = entries.slice(0, MAX_IMPORT_PER_BATCH);
  const newEntries = limitedEntries.filter((entry) => !existingSet.has(entry.address.toLowerCase()));
  const existingDuplicates = limitedEntries.filter((entry) => existingSet.has(entry.address.toLowerCase())).length;
  const overLimit = Math.max(entries.length - MAX_IMPORT_PER_BATCH, 0);

  return {
    validCount: Math.min(entries.length, MAX_IMPORT_PER_BATCH),
    duplicateCount: existingDuplicates + overLimit,
    invalidCount: invalid.length,
    newCount: newEntries.length,
    validAddresses: newEntries.map((entry) => entry.address),
    validEntries: newEntries,
    invalidItems: invalid
  };
}
