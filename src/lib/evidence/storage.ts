import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const STORAGE_ROOT = path.join(process.cwd(), "storage", "evidence");
const STORAGE_KEY_PATTERN = /^[a-z0-9._-]+$/i;

function sanitizeFileNameSegment(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function getExtension(fileName: string) {
  const extension = path.extname(fileName);
  return extension.slice(0, 12);
}

export type ReservedStorageObject = {
  storageKey: string;
  rawStorageUrl: string;
};

export async function ensureStorageRoot() {
  await mkdir(STORAGE_ROOT, { recursive: true });
}

export function reserveStorageObject(originalName: string): ReservedStorageObject {
  const stem = sanitizeFileNameSegment(path.basename(originalName, path.extname(originalName)));
  const extension = getExtension(originalName);
  const safeName = stem.length > 0 ? stem : "evidence";
  const storageKey = `${Date.now()}-${randomUUID()}-${safeName}${extension}`;

  return {
    storageKey,
    rawStorageUrl: `local://evidence/${storageKey}`,
  };
}

export function getStoragePath(storageKey: string) {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) {
    throw new Error("Invalid storage key.");
  }

  return path.join(STORAGE_ROOT, storageKey);
}

export async function writeStorageObject(storageKey: string, data: Buffer) {
  await ensureStorageRoot();
  await writeFile(getStoragePath(storageKey), data);
}

export async function readStorageObject(storageKey: string) {
  return readFile(getStoragePath(storageKey));
}
