/// Symbol-indexing orchestrator.
///
/// Runs *after* a TargRepoSnapshot's tree is populated. For each indexable
/// TargRepoFile, fetches the blob content from GitHub, extracts top-level
/// symbols, and bulk-inserts them into TargRepoSymbol. Bounded so it cannot
/// blow through GitHub rate limits or fill SQLite with noise.
///
/// All caps below are deliberately conservative: this is meant to run inline
/// during an API request. If we exceed any cap we still produce a usable
/// partial index — we just flip the snapshot status to PARTIAL and record why.

import type { PrismaClient } from "@prisma/client";

import { getBlobContent } from "@/lib/github/client";

import { isSymbolIndexable } from "./classify";
import {
  extractSymbols,
  type ExtractedSymbol,
} from "./symbol-extractor";

/// Max indexable files per symbol-sync run. Beyond this, remaining files are
/// skipped and the snapshot is marked PARTIAL.
const MAX_INDEXABLE_FILES = 3_000;
/// Max raw source size we attempt to parse. Bigger files are skipped (bundles,
/// vendored minified code, etc.) — they almost never contain meaningful
/// top-level symbols for our purposes.
const MAX_FILE_SIZE_BYTES = 500_000;
/// Global cap on symbols persisted per snapshot. Prevents a single massive
/// repo from dominating SQLite storage.
const MAX_SYMBOLS_PER_SNAPSHOT = 50_000;
/// Concurrency for blob fetches. GitHub allows 5000 req/hr for authed apps;
/// 6 in flight at ~100-200ms per request stays well under the limit.
const BLOB_FETCH_CONCURRENCY = 6;
/// Batch size for bulk symbol inserts. SQLite performs best with sub-1k
/// batches; matches the batch size used by the tree sync.
const SYMBOL_INSERT_BATCH_SIZE = 500;

export type SymbolSyncResult = {
  filesAttempted: number;
  filesParsed: number;
  filesSkipped: number;
  filesFailed: number;
  symbolsInserted: number;
  partialReasons: string[];
};

export type SymbolSyncInput = {
  prisma: PrismaClient;
  snapshotId: string;
  owner: string;
  name: string;
  token: string;
};

/// Runs symbol extraction for a snapshot. Idempotent: wipes any prior
/// TargRepoSymbol rows for the snapshot before inserting new ones. Updates
/// the snapshot's symbolSyncedAt + symbolCount fields on completion. Status
/// transitions are left to the caller (repo-index-service) so this module
/// doesn't need to know about the PARTIAL/READY policy.
export async function syncSymbolsForSnapshot(
  input: SymbolSyncInput
): Promise<SymbolSyncResult> {
  const files = await input.prisma.targRepoFile.findMany({
    where: { snapshotId: input.snapshotId },
    select: {
      id: true,
      path: true,
      size: true,
      blobSha: true,
      kind: true,
      language: true,
    },
  });

  const indexable = files.filter((f) => isSymbolIndexable(f.kind, f.language));
  const partialReasons: string[] = [];

  let toProcess = indexable;
  if (toProcess.length > MAX_INDEXABLE_FILES) {
    partialReasons.push(
      `Indexed only the first ${MAX_INDEXABLE_FILES} of ${indexable.length} source files.`
    );
    toProcess = toProcess.slice(0, MAX_INDEXABLE_FILES);
  }

  await input.prisma.targRepoSymbol.deleteMany({
    where: { snapshotId: input.snapshotId },
  });

  const result: SymbolSyncResult = {
    filesAttempted: toProcess.length,
    filesParsed: 0,
    filesSkipped: 0,
    filesFailed: 0,
    symbolsInserted: 0,
    partialReasons,
  };

  const insertBuffer: Array<{
    snapshotId: string;
    fileId: string;
    name: string;
    kind: ExtractedSymbol["kind"];
    line: number;
    endLine: number | null;
    exported: boolean;
  }> = [];
  let insertedTotal = 0;
  let capReached = false;

  const flushInsertBuffer = async () => {
    while (insertBuffer.length > 0 && !capReached) {
      const batch = insertBuffer.splice(0, SYMBOL_INSERT_BATCH_SIZE);
      await input.prisma.targRepoSymbol.createMany({ data: batch });
      insertedTotal += batch.length;
      if (insertedTotal >= MAX_SYMBOLS_PER_SNAPSHOT) {
        capReached = true;
        partialReasons.push(
          `Symbol cap reached (${MAX_SYMBOLS_PER_SNAPSHOT}); further symbols skipped.`
        );
      }
    }
  };

  // Process files in concurrency-bounded batches. We use simple array chunks
  // rather than a worker pool because the workload is uniform (one fetch +
  // one parse per file) and the concurrency we want is small.
  for (let i = 0; i < toProcess.length; i += BLOB_FETCH_CONCURRENCY) {
    if (capReached) break;
    const chunk = toProcess.slice(i, i + BLOB_FETCH_CONCURRENCY);
    const fetched = await Promise.all(
      chunk.map(async (file) => {
        if (file.size > MAX_FILE_SIZE_BYTES) {
          result.filesSkipped += 1;
          return null;
        }
        try {
          const content = await getBlobContent(
            input.token,
            input.owner,
            input.name,
            file.blobSha
          );
          return { file, content };
        } catch {
          result.filesFailed += 1;
          return null;
        }
      })
    );

    for (const entry of fetched) {
      if (!entry) continue;
      const { file, content } = entry;
      const language =
        file.language === "typescript" ? "typescript" : "javascript";
      const parsed = extractSymbols(content, {
        language,
        filename: file.path,
      });
      result.filesParsed += 1;

      for (const sym of parsed.symbols) {
        if (capReached) break;
        insertBuffer.push({
          snapshotId: input.snapshotId,
          fileId: file.id,
          name: sym.name,
          kind: sym.kind,
          line: sym.line,
          endLine: sym.endLine ?? null,
          exported: sym.exported,
        });
        if (insertBuffer.length >= SYMBOL_INSERT_BATCH_SIZE) {
          await flushInsertBuffer();
        }
      }
    }
  }

  if (!capReached && insertBuffer.length > 0) {
    await flushInsertBuffer();
  }

  result.symbolsInserted = insertedTotal;

  await input.prisma.targRepoSnapshot.update({
    where: { id: input.snapshotId },
    data: {
      symbolCount: insertedTotal,
      symbolSyncedAt: new Date(),
    },
  });

  return result;
}
