"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, Play, Search, Trash2, XCircle } from "lucide-react";
import { buildImportPreview, normalizeAddresses, parseAddressEntries } from "@/lib/address";
import { db, clearLocalDatabase } from "@/lib/db";
import { calculateTotals, downloadCsv, formatNumber, formatUsd, shortAddress } from "@/lib/format";
import { createPendingResult, queryAddressesStreaming } from "@/lib/query";
import type { AddressResult, ImportPreview, StoredAddress, StoredBatch } from "@/lib/types";

type QueryScope = "input" | "batch" | "all";
type SortKey = "totalValue" | "pusdBalance" | "positionsValue" | "tradeVolume" | "lastTradeNewest" | "lastTradeOldest";
const MANUAL_NOTE_BATCH_NAME = "手动备注地址";

export default function Home() {
  const [input, setInput] = useState("");
  const [batchName, setBatchName] = useState("");
  const [addresses, setAddresses] = useState<StoredAddress[]>([]);
  const [batches, setBatches] = useState<StoredBatch[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [results, setResults] = useState<AddressResult[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("totalValue");
  const [savingNoteAddress, setSavingNoteAddress] = useState<string | null>(null);
  const [querying, setQuerying] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [totalToQuery, setTotalToQuery] = useState(0);
  const [notice, setNotice] = useState("所有地址库、查询结果、查询历史只保存在当前浏览器本地，不会上传到自建服务器数据库。");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void loadLocalData();
  }, []);

  async function loadLocalData() {
    const [storedAddresses, storedBatches, latestResults] = await Promise.all([
      db.addresses.orderBy("createdAt").toArray(),
      db.batches.orderBy("createdAt").reverse().toArray(),
      db.latestResults.toArray()
    ]);
    setAddresses(storedAddresses);
    setBatches(storedBatches);
    setSelectedBatchId((current) => current || storedBatches[0]?.id || "");
    setResults(latestResults);
  }

  const preview: ImportPreview = useMemo(() => buildImportPreview(input, addresses), [input, addresses]);
  const totals = useMemo(() => calculateTotals(results), [results]);
  const hasIncompleteLpRewards = results.some(
    (result) => result.status === "success" && (result.lpRewardsStatus === "partial" || result.lpRewardsStatus === "failed")
  );
  const hasIncompleteTradeStats = results.some(
    (result) => result.status === "success" && (result.tradeStatsStatus === "partial" || result.tradeStatsStatus === "failed")
  );
  const progress = totalToQuery > 0 ? Math.round((completed / totalToQuery) * 100) : 0;
  const noteByAddress = useMemo(() => new Map(addresses.map((item) => [item.address.toLowerCase(), item.note ?? ""])), [addresses]);

  const visibleResults = useMemo(() => {
    return results
      .filter((result) => result.address.toLowerCase().includes(searchTerm.trim().toLowerCase()) || (result.note ?? "").toLowerCase().includes(searchTerm.trim().toLowerCase()))
      .sort(compareResults(sortKey));
  }, [results, searchTerm, sortKey]);

  async function importBatch() {
    if (preview.validCount > 300) {
      setNotice("每批最多导入 300 个有效地址，请拆分后再导入。");
      return;
    }
    if (preview.newCount === 0) {
      setNotice("没有可新增的有效地址。");
      return;
    }

    const now = Date.now();
    const batchId = crypto.randomUUID();
    const name = batchName.trim() || `批次 ${new Date(now).toLocaleString()}`;
    const rows = preview.validEntries.map((entry) => ({
      address: entry.address,
      batchId,
      createdAt: now,
      note: entry.note
    }));
    const batch: StoredBatch = { id: batchId, name, createdAt: now, importedCount: rows.length };

    await db.transaction("rw", db.addresses, db.batches, async () => {
      await db.batches.add(batch);
      await db.addresses.bulkPut(rows);
    });

    setBatchName("");
    setNotice(`已导入 ${rows.length} 个新地址。`);
    await loadLocalData();
  }

  async function deleteBatch(batchId: string) {
    const batch = batches.find((item) => item.id === batchId);
    await db.transaction("rw", db.addresses, db.batches, async () => {
      await db.addresses.where("batchId").equals(batchId).delete();
      await db.batches.delete(batchId);
    });
    setNotice(`已删除批次：${batch?.name ?? batchId}`);
    await loadLocalData();
  }

  async function saveResultNote(address: string, note: string) {
    try {
      const hadAddress = addresses.some((item) => item.address.toLowerCase() === address.toLowerCase());
      setSavingNoteAddress(address.toLowerCase());
      await persistNote(address, note);
      applyNoteToState(address, note);
      if (!hadAddress) await loadLocalData();
      setNotice("备注已保存。");
    } catch (error) {
      setNotice(error instanceof Error ? `备注保存失败：${error.message}` : "备注保存失败。");
      throw error;
    } finally {
      setSavingNoteAddress(null);
    }
  }

  async function persistNote(address: string, note: string) {
    const now = Date.now();
    await db.transaction("rw", db.addresses, db.batches, db.latestResults, async () => {
      const existing = await db.addresses.get(address);
      if (existing) {
        await db.addresses.update(address, { note });
      } else {
        const batches = await db.batches.toArray();
        let batch = batches.find((item) => item.name === MANUAL_NOTE_BATCH_NAME);
        if (!batch) {
          batch = {
            id: crypto.randomUUID(),
            name: MANUAL_NOTE_BATCH_NAME,
            createdAt: now,
            importedCount: 0
          };
          await db.batches.add(batch);
        }
        await db.addresses.put({ address, batchId: batch.id, createdAt: now, note });
        await db.batches.update(batch.id, { importedCount: batch.importedCount + 1 });
      }
      await db.latestResults.update(address, { note });
    });
  }

  function applyNoteToState(address: string, note: string) {
    const key = address.toLowerCase();
    setAddresses((items) => {
      if (items.some((item) => item.address.toLowerCase() === key)) {
        return items.map((item) => item.address.toLowerCase() === key ? { ...item, note } : item);
      }
      const batch = batches.find((item) => item.name === MANUAL_NOTE_BATCH_NAME);
      return [...items, { address, batchId: batch?.id ?? MANUAL_NOTE_BATCH_NAME, createdAt: Date.now(), note }];
    });
    setResults((items) => items.map((item) => item.address.toLowerCase() === key ? { ...item, note } : item));
  }

  async function clearAll() {
    if (!window.confirm("确认清空当前浏览器本地保存的地址、结果和查询历史吗？")) return;
    await clearLocalDatabase();
    setAddresses([]);
    setBatches([]);
    setResults([]);
    setCompleted(0);
    setTotalToQuery(0);
    setNotice("本地数据已清空。");
  }

  function getQueryEntries(scope: QueryScope) {
    if (scope === "input") {
      const parsed = parseAddressEntries(input).entries;
      return parsed.map((entry) => ({
        address: entry.address,
        note: noteByAddress.get(entry.address.toLowerCase()) || entry.note || ""
      }));
    }
    if (scope === "batch") {
      return addresses
        .filter((item) => item.batchId === selectedBatchId)
        .map((item) => ({ address: item.address, note: item.note ?? "" }));
    }
    return addresses.map((item) => ({ address: item.address, note: item.note ?? "" }));
  }

  function getQueryAddresses(scope: QueryScope) {
    if (scope === "input") return normalizeAddresses(input).valid;
    return getQueryEntries(scope).map((item) => item.address);
  }

  async function runQuery(scope: QueryScope) {
    const queryEntries = dedupeEntries(getQueryEntries(scope));
    const queryAddresses = queryEntries.map((entry) => entry.address);
    const queryNotes = new Map(queryEntries.map((entry) => [entry.address.toLowerCase(), entry.note]));
    if (queryAddresses.length === 0) {
      setNotice("没有可查询的有效地址。");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setQuerying(true);
    setCompleted(0);
    setTotalToQuery(queryAddresses.length);
    setResults(queryAddresses.map((address) => createPendingResult(address, queryNotes.get(address.toLowerCase()))));
    setNotice("查询中，结果会边返回边更新。");

    const resultMap = new Map(queryAddresses.map((address) => [address.toLowerCase(), createPendingResult(address, queryNotes.get(address.toLowerCase()))]));

    try {
      await queryAddressesStreaming(queryAddresses, controller.signal, (result, done) => {
        const note = queryNotes.get(result.address.toLowerCase());
        const resultWithNote = { ...result, note };
        resultMap.set(result.address.toLowerCase(), resultWithNote);
        const nextResults = Array.from(resultMap.values());
        setResults(nextResults);
        setCompleted(done);
        void db.latestResults.put(resultWithNote);
      });

      const finalResults = Array.from(resultMap.values());
      await db.querySnapshots.add({
        id: crypto.randomUUID(),
        scope: scope === "input" ? "当前输入地址" : scope === "batch" ? "选中批次" : "全部已保存地址",
        createdAt: Date.now(),
        totals: calculateTotals(finalResults),
        results: finalResults
      });
      setNotice(controller.signal.aborted ? "查询已取消，已保留当前结果。" : "查询完成。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "查询失败，请检查网络或 RPC 配置。");
    } finally {
      setQuerying(false);
      abortRef.current = null;
    }
  }

  function cancelQuery() {
    abortRef.current?.abort();
    setNotice("正在取消查询，已发出的少量请求可能会先返回。");
  }

  function exportAddresses() {
    downloadCsv("polymarket-addresses.csv", [
      ["address", "batchId", "createdAt", "note"],
      ...addresses.map((row) => [row.address, row.batchId, new Date(row.createdAt).toISOString(), row.note ?? ""])
    ]);
  }

  function exportResults() {
    downloadCsv("polymarket-results.csv", [
      ["address", "note", "pusdBalance", "positionsValue", "totalValue", "tradeVolume", "marketCount", "activeMonths", "activeDays", "tradeStatsStatus", "tradeStatsError", "lpRewards", "lpRewardsStatus", "lpRewardsError", "lastTradeTime", "status", "error"],
      ...results.map((row) => [
        row.address,
        row.note ?? "",
        row.pusdBalance,
        row.positionsValue,
        row.totalValue,
        row.tradeVolume,
        row.marketCount,
        row.activeMonths,
        row.activeDays,
        row.tradeStatsStatus ?? "",
        row.tradeStatsError ?? "",
        row.lpRewards ?? "",
        row.lpRewardsStatus ?? "",
        row.lpRewardsError ?? "",
        row.lastTradeTime ?? lastTradeDisplay(row),
        row.status,
        row.error ?? ""
      ])
    ]);
  }

  return (
    <main className="min-h-screen px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-teal-700">Polymarket Portfolio Dashboard</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-950 sm:text-3xl">多地址资产批量查询</h1>
          </div>
          <p className="max-w-2xl rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{notice}</p>
        </header>

        <section className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-950">地址导入区</h2>
              <span className="text-sm text-slate-500">每批最多 300 个</span>
            </div>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="粘贴 Polymarket / EVM 地址，可用换行、空格、逗号分隔；地址后可加备注"
              className="mt-3 h-44 w-full resize-y rounded-md border border-slate-300 bg-white p-3 text-sm outline-none ring-teal-500 focus:ring-2"
            />
            <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
              <input
                value={batchName}
                onChange={(event) => setBatchName(event.target.value)}
                placeholder="批次名称，例如 Team A / 2026-05-04"
                className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none ring-teal-500 focus:ring-2"
              />
              <button onClick={importBatch} disabled={querying} className="inline-flex items-center justify-center gap-2 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800">
                <Play size={16} /> 导入地址
              </button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Metric label="有效地址" value={preview.validCount} />
              <Metric label="重复地址" value={preview.duplicateCount} />
              <Metric label="无效地址" value={preview.invalidCount} />
              <Metric label="本次新增" value={preview.newCount} />
            </div>
          </div>

          <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-950">地址库区</h2>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <Metric label="本地地址总数" value={addresses.length} />
              <Metric label="批次数量" value={batches.length} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={exportAddresses} disabled={addresses.length === 0} className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                <Download size={16} /> 导出全部地址 CSV
              </button>
              <button onClick={clearAll} className="inline-flex items-center gap-2 rounded-md border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50">
                <Trash2 size={16} /> 清空本地数据
              </button>
            </div>
            <div className="mt-3 max-h-52 overflow-auto rounded-md border border-slate-200">
              {batches.length === 0 ? (
                <p className="p-3 text-sm text-slate-500">暂无批次</p>
              ) : (
                batches.map((batch) => (
                  <div key={batch.id} className="flex items-center justify-between gap-3 border-b border-slate-100 p-3 last:border-b-0">
                    <button onClick={() => setSelectedBatchId(batch.id)} className={`min-w-0 text-left text-sm ${selectedBatchId === batch.id ? "font-semibold text-teal-700" : "text-slate-700"}`}>
                      <span className="block truncate">{batch.name}</span>
                      <span className="text-xs text-slate-500">{batch.importedCount} 个地址</span>
                    </button>
                    <button aria-label="删除批次" onClick={() => deleteBatch(batch.id)} disabled={querying} className="rounded-md p-2 text-red-600 hover:bg-red-50">
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">查询控制区</h2>
              <p className="mt-1 text-sm text-slate-500">并发限制 10，单地址失败重试 2 次，失败不会中断整批查询。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => runQuery("input")} disabled={querying} className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800">
                <Search size={16} /> 查询当前输入
              </button>
              <button onClick={() => runQuery("batch")} disabled={querying || !selectedBatchId} className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800">
                <Search size={16} /> 查询选中批次
              </button>
              <button onClick={() => runQuery("all")} disabled={querying || addresses.length === 0} className="inline-flex items-center gap-2 rounded-md bg-indigo-700 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-800">
                {querying ? <Loader2 className="animate-spin" size={16} /> : <Search size={16} />} 查询全部已保存
              </button>
              <button onClick={cancelQuery} disabled={!querying} className="inline-flex items-center gap-2 rounded-md border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50">
                <XCircle size={16} /> 取消查询
              </button>
            </div>
          </div>
          <div className="mt-4">
            <div className="mb-1 flex items-center justify-between text-sm text-slate-600">
              <span>进度</span>
              <span>{completed} / {totalToQuery}</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full bg-teal-600 transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-7">
          <Overview label="总资产" value={formatUsd(totals.totalValue)} />
          <Overview label="总余额" value={formatUsd(totals.totalPusdBalance)} />
          <Overview label="总持仓市值" value={formatUsd(totals.totalPositionsValue)} />
          <Overview label={hasIncompleteTradeStats ? "总交易额（含部分统计）" : "总交易额"} value={formatUsd(totals.totalTradeVolume)} />
          <Overview label={hasIncompleteLpRewards ? "总 LP 奖励（含部分统计）" : "总 LP 奖励"} value={formatUsd(totals.totalLpRewards ?? 0)} />
          <Overview label="成功地址数" value={totals.successCount} />
          <Overview label="失败地址数" value={totals.failedCount} danger={totals.failedCount > 0} />
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <h2 className="text-lg font-semibold text-slate-950">结果明细区</h2>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="搜索地址或备注" className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none ring-teal-500 focus:ring-2" />
              <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)} className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none ring-teal-500 focus:ring-2">
                <option value="totalValue">按总资产排序</option>
                <option value="pusdBalance">按余额排序</option>
                <option value="positionsValue">按持仓市值排序</option>
                <option value="tradeVolume">按历史交易额排序</option>
                <option value="lastTradeNewest">按最近交易时间排序：最新优先</option>
                <option value="lastTradeOldest">按最近交易时间排序：最旧优先</option>
              </select>
              <button onClick={exportResults} disabled={results.length === 0} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                <Download size={16} /> 导出结果 CSV
              </button>
            </div>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[1320px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="px-2 py-2">地址</th>
                  <th className="px-2 py-2">备注</th>
                  <th className="px-2 py-2 text-right">pUSD 余额</th>
                  <th className="px-2 py-2 text-right">持仓市值</th>
                  <th className="px-2 py-2 text-right">总资产</th>
                  <th className="px-2 py-2 text-right">历史总交易金额</th>
                  <th className="px-2 py-2 text-right">总交易市场数</th>
                  <th className="px-2 py-2 text-right">月活跃时间</th>
                  <th className="px-2 py-2 text-right">日活跃时间</th>
                  <th className="px-2 py-2 text-right">历史 LP 奖励</th>
                  <th className="px-2 py-2">最近交易时间</th>
                  <th className="px-2 py-2">查询状态</th>
                  <th className="px-2 py-2">错误信息</th>
                </tr>
              </thead>
              <tbody>
                {visibleResults.length === 0 ? (
                  <tr><td colSpan={13} className="px-2 py-8 text-center text-slate-500">暂无查询结果</td></tr>
                ) : (
                  visibleResults.map((result) => (
                    <ResultRow
                      key={result.address}
                      result={result}
                      savingNote={savingNoteAddress === result.address.toLowerCase()}
                      onSaveNote={saveResultNote}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

function dedupeEntries(entries: Array<{ address: string; note?: string }>) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = entry.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareResults(sortKey: SortKey) {
  return (a: AddressResult, b: AddressResult) => {
    if (sortKey === "lastTradeNewest" || sortKey === "lastTradeOldest") {
      const aTime = a.lastTradeStatus === "success" ? a.lastTradeTimestamp ?? 0 : 0;
      const bTime = b.lastTradeStatus === "success" ? b.lastTradeTimestamp ?? 0 : 0;
      if (!aTime && !bTime) return 0;
      if (!aTime) return 1;
      if (!bTime) return -1;
      return sortKey === "lastTradeNewest" ? bTime - aTime : aTime - bTime;
    }
    return b[sortKey] - a[sortKey];
  };
}

function lastTradeDisplay(result: AddressResult) {
  if (result.lastTradeStatus === "success") return result.lastTradeTime ?? "";
  if (result.lastTradeStatus === "empty") return "无交易记录";
  if (result.lastTradeStatus === "failed") return "查询失败";
  return "未查询";
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-slate-50 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-950">{value}</div>
    </div>
  );
}

function Overview({ label, value, danger }: { label: string; value: string | number; danger?: boolean }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3 shadow-sm">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-2 break-words text-lg font-bold ${danger ? "text-red-700" : "text-slate-950"}`}>{value}</div>
    </div>
  );
}

function ResultRow({
  result,
  onSaveNote,
  savingNote
}: {
  result: AddressResult;
  onSaveNote: (address: string, note: string) => Promise<void>;
  savingNote: boolean;
}) {
  const statusClass = result.status === "success" ? "bg-emerald-50 text-emerald-700" : result.status === "failed" ? "bg-red-50 text-red-700" : result.status === "canceled" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600";
  const pending = result.status === "pending";
  const pendingValue = "-";
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(result.note ?? "");

  async function saveDraft() {
    const nextNote = noteDraft.trim();
    setEditingNote(false);
    if (nextNote === (result.note ?? "")) return;
    await onSaveNote(result.address, nextNote);
  }

  return (
    <tr className="border-b border-slate-100 align-top">
      <td className="px-2 py-2">
        <details>
          <summary className="cursor-pointer font-mono text-xs font-semibold text-teal-700">{shortAddress(result.address)}</summary>
          <div className="mt-2 rounded-md bg-slate-50 p-2">
            <div className="mb-2 break-all font-mono text-xs text-slate-600">{result.address}</div>
            {result.positions.length === 0 ? (
              <div className="text-xs text-slate-500">暂无 positions 明细</div>
            ) : (
              <div className="space-y-2">
                {result.positions.map((position, index) => (
                  <div key={`${position.market}-${position.outcome}-${index}`} className="rounded-md border border-slate-200 bg-white p-2 text-xs">
                    <div className="font-semibold text-slate-800">{position.market}</div>
                    <div className="mt-1 grid grid-cols-2 gap-1 text-slate-600">
                      <span>outcome: {position.outcome}</span>
                      <span>size: {formatNumber(position.size)}</span>
                      <span>avgPrice: {formatNumber(position.avgPrice)}</span>
                      <span>currentValue: {formatUsd(position.currentValue)}</span>
                      <span className={position.cashPnl >= 0 ? "text-emerald-700" : "text-red-700"}>cashPnl: {formatUsd(position.cashPnl)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>
      </td>
      <td className="max-w-40 px-2 py-2">
        {editingNote ? (
          <input
            autoFocus
            disabled={savingNote}
            value={noteDraft}
            onChange={(event) => setNoteDraft(event.target.value)}
            onBlur={() => void saveDraft()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setNoteDraft(result.note ?? "");
                setEditingNote(false);
              }
            }}
            className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs outline-none ring-teal-500 focus:ring-1"
          />
        ) : (
          <button
            type="button"
            disabled={savingNote}
            onClick={() => {
              setNoteDraft(result.note ?? "");
              setEditingNote(true);
            }}
            className="block max-w-full truncate text-left text-slate-700 hover:text-teal-700 disabled:opacity-60"
            title={result.note ?? ""}
          >
            {savingNote ? "保存中..." : result.note || "添加备注"}
          </button>
        )}
      </td>
      <td className="px-2 py-2 text-right">{pending ? pendingValue : formatUsd(result.pusdBalance)}</td>
      <td className="px-2 py-2 text-right">{pending ? pendingValue : formatUsd(result.positionsValue)}</td>
      <td className="px-2 py-2 text-right font-semibold">{pending ? pendingValue : formatUsd(result.totalValue)}</td>
      <td className="px-2 py-2 text-right">
        {pending ? pendingValue : formatUsd(result.tradeVolume)}
        {!pending && result.tradeStatsStatus === "partial" ? (
          <div className="mt-1 text-xs text-amber-700" title={result.tradeStatsError ?? ""}>部分统计</div>
        ) : null}
        {!pending && result.tradeStatsStatus === "failed" ? (
          <div className="mt-1 text-xs text-red-700" title={result.tradeStatsError ?? ""}>统计失败</div>
        ) : null}
      </td>
      <td className="px-2 py-2 text-right">{pending ? pendingValue : result.marketCount}</td>
      <td className="px-2 py-2 text-right">{pending ? pendingValue : result.activeMonths}</td>
      <td className="px-2 py-2 text-right">{pending ? pendingValue : result.activeDays}</td>
      <td className="px-2 py-2 text-right">
        {pending || result.lpRewards === undefined ? pendingValue : formatUsd(result.lpRewards)}
        {!pending && result.lpRewardsStatus === "partial" ? (
          <div className="mt-1 text-xs text-amber-700" title={result.lpRewardsError ?? ""}>部分统计</div>
        ) : null}
        {!pending && result.lpRewardsStatus === "failed" ? (
          <div className="mt-1 text-xs text-red-700" title={result.lpRewardsError ?? ""}>统计失败</div>
        ) : null}
      </td>
      <td className="px-2 py-2">{pending ? pendingValue : lastTradeDisplay(result)}</td>
      <td className="px-2 py-2"><span className={`rounded-md px-2 py-1 text-xs font-semibold ${statusClass}`}>{result.status}</span></td>
      <td className="max-w-56 px-2 py-2 text-red-700">{result.error ?? ""}</td>
    </tr>
  );
}
