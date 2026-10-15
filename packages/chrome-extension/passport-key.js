const DATABASE_NAME = "paseo-browser-passport";
const STORE_NAME = "keys";
const KEY_ID = "profile-key-v1";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE_NAME));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function getStoredKey(database) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(KEY_ID);
    request.addEventListener("success", () => resolve(request.result ?? null));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function storeKey(database, pair) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).add(pair, KEY_ID);
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

export async function getOrCreateProfileKey() {
  const database = await openDatabase();
  try {
    const stored = await getStoredKey(database);
    if (stored) return stored;
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    try {
      await storeKey(database, pair);
      return pair;
    } catch (error) {
      const raced = await getStoredKey(database);
      if (raced) return raced;
      throw error;
    }
  } finally {
    database.close();
  }
}

export function bytesToBase64(bytes) {
  const data = new Uint8Array(bytes);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function exportPublicKeyBase64(pair) {
  return bytesToBase64(await crypto.subtle.exportKey("spki", pair.publicKey));
}

export function passportMessage(challenge) {
  return new TextEncoder().encode(
    JSON.stringify([
      "paseo-browser-passport-v1",
      challenge.id,
      challenge.nonce,
      challenge.clientId,
      challenge.host,
      challenge.chromePath,
      challenge.profileDirectory,
      challenge.extensionOrigin,
      challenge.expiresAt,
    ]),
  );
}

export async function signChallenge(pair, challenge) {
  return bytesToBase64(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      passportMessage(challenge),
    ),
  );
}
