import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

interface MossDBSchema extends DBSchema {
  settings: {
    key: string;
    value: unknown;
  };
}

const DB_NAME = 'MOSS-DB';
const DB_VERSION = 1;
const SETTINGS_STORE = 'settings';

/** 旧数据库名（改名前的 `moss-db`），用于一次性迁移 */
const LEGACY_DB_NAME = 'moss-db';

const memoryCache = new Map<string, unknown>();
let dbPromise: Promise<IDBPDatabase<MossDBSchema>> | null = null;

function getDB(): Promise<IDBPDatabase<MossDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<MossDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
          db.createObjectStore(SETTINGS_STORE);
        }
      },
    });
    // 打开失败（隐身模式/配额/库损坏等）不缓存 rejected promise：
    // 后续调用可重试；期间读写走内存降级，不让 IndexedDB 故障炸掉整个应用
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

// 异步读取：优先读内存缓存，未命中则读 IndexedDB 并回填缓存
export async function idbGet<T>(key: string): Promise<T | undefined> {
  if (memoryCache.has(key)) {
    return memoryCache.get(key) as T;
  }
  try {
    const db = await getDB();
    const value = (await db.get(SETTINGS_STORE, key)) as T | undefined;
    memoryCache.set(key, value);
    return value;
  } catch {
    // IndexedDB 不可用：降级纯内存读（undefined = 视为未存储，走调用方默认值）
    return undefined;
  }
}

// 同步读取：仅读内存缓存（需先经过 idbGet 预填充，例如 main.tsx 启动时）
export function idbGetSync<T>(key: string): T | undefined {
  return memoryCache.get(key) as T | undefined;
}

// 写入：同时更新内存缓存与 IndexedDB
export async function idbSet<T>(key: string, value: T): Promise<void> {
  memoryCache.set(key, value);
  try {
    const db = await getDB();
    await db.put(SETTINGS_STORE, value, key);
  } catch {
    // IndexedDB 不可用：降级仅内存写（本会话生效，重启回落默认值）
  }
}

/**
 * 一次性迁移：把某个旧 localStorage key 搬入 IndexedDB（同时写入内存缓存）。
 * IndexedDB 已有值或 localStorage 无值时跳过；完成后清除 localStorage 旧值。
 * 仅适用于普通 JSON 数据：认证令牌、首帧主题快照等需要同步读取的项不适用。
 */
export async function migrateLegacyLocalStorage(key: string): Promise<void> {
  try {
    const current = await idbGet<unknown>(key);
    if (current !== undefined) return;
    const legacy = localStorage.getItem(key);
    if (legacy === null) return;
    let parsed: unknown = legacy;
    try {
      parsed = JSON.parse(legacy);
    } catch {
      // 非 JSON：按原始字符串迁移
    }
    await idbSet(key, parsed);
    localStorage.removeItem(key);
  } catch {
    // 迁移失败静默：保留旧值，下次启动再试
  }
}

/**
 * 一次性迁移：把改名前的旧库 `moss-db` 全部条目搬入新库 `MOSS-DB`（同时写入内存缓存），
 * 完成后删除旧库。旧库不存在或迁移失败时静默忽略，不阻塞启动。
 */
export async function migrateLegacyDatabase(): Promise<void> {
  let legacy: IDBPDatabase<MossDBSchema> | null = null;
  try {
    legacy = await openDB<MossDBSchema>(LEGACY_DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
          db.createObjectStore(SETTINGS_STORE);
        }
      },
    });
    const values = await legacy.getAll(SETTINGS_STORE);
    const keys = await legacy.getAllKeys(SETTINGS_STORE);
    for (let i = 0; i < keys.length; i++) {
      await idbSet(String(keys[i]), values[i]);
    }
  } catch {
    // 迁移失败静默，忽略
  } finally {
    legacy?.close();
    indexedDB.deleteDatabase(LEGACY_DB_NAME);
  }
}
