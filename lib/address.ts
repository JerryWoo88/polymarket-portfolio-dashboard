import { getAddress, isAddress } from "viem";
import { MAX_IMPORT_PER_BATCH } from "./constants";
import type { ImportPreview, StoredAddress } from "./types";

export function extractAddressCandidates(input: string) {
  return input
    .split(/[\s,;，；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeAddresses(input: string) {
  const candidates = extractAddressCandidates(input);
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (!isAddress(candidate)) {
      invalid.push(candidate);
      continue;
    }
    const normalized = getAddress(candidate);
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      valid.push(normalized);
      seen.add(key);
    }
  }

  return { valid, invalid };
}

export function buildImportPreview(input: string, existing: StoredAddress[]): ImportPreview {
  const { valid, invalid } = normalizeAddresses(input);
  const existingSet = new Set(existing.map((item) => item.address.toLowerCase()));
  const newAddresses = valid.slice(0, MAX_IMPORT_PER_BATCH).filter((address) => !existingSet.has(address.toLowerCase()));
  const duplicatesInInput = extractAddressCandidates(input).length - valid.length - invalid.length;
  const existingDuplicates = valid.filter((address) => existingSet.has(address.toLowerCase())).length;
  const overLimit = Math.max(valid.length - MAX_IMPORT_PER_BATCH, 0);

  return {
    validCount: Math.min(valid.length, MAX_IMPORT_PER_BATCH),
    duplicateCount: duplicatesInInput + existingDuplicates + overLimit,
    invalidCount: invalid.length,
    newCount: newAddresses.length,
    validAddresses: newAddresses,
    invalidItems: invalid
  };
}
