// Persistencia en el navegador (IndexedDB): .sav por cartucho, estados rápidos y la boot
// ROM del usuario (nunca va al repo). Un único almacén clave → {data, time}.
const DB = "gbcemuiator";
const STORE = "files";

interface Entry { data: Uint8Array; time: number }

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const r = f(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(r.error);
  }));
}

export async function getFile(key: string): Promise<Entry | null> {
  return (await tx<Entry | undefined>("readonly", (s) => s.get(key))) ?? null;
}

export async function putFile(key: string, data: Uint8Array): Promise<void> {
  await tx("readwrite", (s) => s.put({ data, time: Date.now() } satisfies Entry, key));
}

export async function deleteFile(key: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(key));
}

/** Identificador estable de un cartucho: título + checksum global de la cabecera. */
export function cartKey(title: string, globalChecksum: number): string {
  return `${title || "untitled"}#${globalChecksum.toString(16).padStart(4, "0")}`;
}
