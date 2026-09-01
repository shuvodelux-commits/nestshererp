/**
 * This browser profile's identity (§5.23, D-01).
 *
 * A keypair generated here, whose **private half is non-extractable and never
 * leaves this profile**. That single property is what D-01 is built on: the
 * server binds offline authority to the public key, so copying the offline
 * storage files into another browser profile carries the data but not the
 * right to write — the second profile cannot prove it holds the private half,
 * because it does not.
 *
 * Stored in IndexedDB rather than `localStorage`, because a `CryptoKey` can be
 * stored as a live object there without ever being serialised. A key that had
 * to be written out as text to be saved would be a key that can be read out as
 * text and pasted somewhere else.
 *
 * Clearing site data destroys it, and that is not a bug: the machine comes back
 * as a **new device**, which is exactly what it is, and the owner hands the
 * writer slot over through Replace Writer.
 */
const DB_NAME = 'sher-offline';
const STORE = 'identity';
const KEY_ID = 'device-keypair';

export interface DeviceIdentity {
  /** Base64url SPKI — what the server stores and every call carries. */
  readonly publicKey: string;
  /** Kept for later phases, which sign push batches with it. Never exported. */
  readonly privateKey: CryptoKey;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('Cannot open local storage'));
  });
}

async function read(db: IDBDatabase): Promise<CryptoKeyPair | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const get = tx.objectStore(STORE).get(KEY_ID) as IDBRequest<CryptoKeyPair | undefined>;
    get.onsuccess = () => resolve(get.result ?? null);
    get.onerror = () => reject(get.error ?? new Error('Cannot read this computer’s identity'));
  });
}

async function write(db: IDBDatabase, pair: CryptoKeyPair): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(pair, KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Cannot save this computer’s identity'));
  });
}

function base64url(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let cached: Promise<DeviceIdentity | null> | null = null;

/**
 * This profile's identity, creating it the first time it is asked for.
 *
 * Null when the browser will not give us one at all — a private window with
 * IndexedDB blocked, or a context with no WebCrypto. Null is a state the
 * screens draw ("this browser cannot be registered"), never an exception
 * thrown at whatever was on screen at the time.
 */
export function deviceIdentity(): Promise<DeviceIdentity | null> {
  cached ??= create();
  return cached;
}

async function create(): Promise<DeviceIdentity | null> {
  try {
    const db = await openDb();
    const existing = await read(db);
    const pair =
      existing ??
      (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
        'verify',
      ]));
    if (existing === null) await write(db, pair);

    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    return { publicKey: base64url(spki), privateKey: pair.privateKey };
  } catch {
    return null;
  }
}

/** Just the public key, for the header every offline call carries. */
export async function deviceKey(): Promise<string | null> {
  return (await deviceIdentity())?.publicKey ?? null;
}

/**
 * What this browser is, in words a shopkeeper can match to a machine.
 *
 * Deliberately coarse — "Chrome on Windows" — and never a fingerprint. It is
 * there so the person approving a request can tell the counter PC from their
 * own phone, not to identify anybody.
 */
export function describeThisBrowser(): string {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /OPR\//.test(agent)
      ? 'Opera'
      : /Firefox\//.test(agent)
        ? 'Firefox'
        : /Chrome\//.test(agent)
          ? 'Chrome'
          : /Safari\//.test(agent)
            ? 'Safari'
            : 'Browser';
  const platform = /Windows/.test(agent)
    ? 'Windows'
    : /Android/.test(agent)
      ? 'Android'
      : /iPhone|iPad/.test(agent)
        ? 'iPhone or iPad'
        : /Mac OS X/.test(agent)
          ? 'Mac'
          : /Linux/.test(agent)
            ? 'Linux'
            : 'this computer';
  return `${browser} on ${platform}`;
}

/** The name a fresh registration suggests, e.g. "Counter PC — Chrome". */
export function suggestedDeviceName(): string {
  return describeThisBrowser();
}
