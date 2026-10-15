import { exportPublicKeyBase64, getOrCreateProfileKey } from "./passport-key.js";

try {
  const pair = await getOrCreateProfileKey();
  const publicKeySpkiBase64 = await exportPublicKeyBase64(pair);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .match(/.{1,4}/g)
    .join(":");
  document.getElementById("origin").textContent = chrome.runtime.getURL("");
  document.getElementById("fingerprint").textContent = fingerprint;
  document.getElementById("public-key").textContent = publicKeySpkiBase64;
  document.getElementById("status").textContent = "This page displays public pairing data only.";
} catch {
  document.getElementById("status").textContent = "Pairing data is unavailable in this profile.";
}
