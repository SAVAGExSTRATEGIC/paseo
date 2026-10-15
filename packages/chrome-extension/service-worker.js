import { createBrowserCommandHandler, SUPPORTED_COMMANDS } from "./browser-commands.js";
import { exportPublicKeyBase64, getOrCreateProfileKey, signChallenge } from "./passport-key.js";

const NATIVE_HOST = "io.paseo.browser_passport";
const RECONNECT_ALARM = "browser-passport-reconnect";
const browserCommands = createBrowserCommandHandler(chrome);
let nativePort = null;
let ready = false;
let signedChallengeId = null;

async function handleNativeMessage(port, message) {
  if (port !== nativePort) return;
  if (message?.type === "passport.challenge") {
    const challenge = message.challenge;
    ready = false;
    if (
      !challenge ||
      challenge.extensionOrigin !== chrome.runtime.getURL("") ||
      challenge.profileDirectory !== "Profile 3" ||
      challenge.chromePath !== "/Applications/Google Chrome.app" ||
      !Number.isSafeInteger(challenge.expiresAt) ||
      challenge.expiresAt <= Date.now()
    ) {
      port.postMessage({ type: "passport.error", reason: "binding_mismatch" });
      return;
    }
    const pair = await getOrCreateProfileKey();
    signedChallengeId = challenge.id;
    port.postMessage({
      type: "passport.signature",
      challengeId: challenge.id,
      signatureBase64: await signChallenge(pair, challenge),
    });
    return;
  }
  if (message?.type === "passport.ready") {
    ready = message.challengeId === signedChallengeId;
    if (ready) browserCommands.reset();
    return;
  }
  if (message?.type === "browser.execute" && ready) {
    const response = await browserCommands.execute(message.request);
    port.postMessage({ type: "browser.result", response });
  }
}

async function connect() {
  if (nativePort) return;
  const pair = await getOrCreateProfileKey();
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch {
    chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 1 });
    return;
  }
  nativePort = port;
  ready = false;
  signedChallengeId = null;
  browserCommands.reset();
  port.onMessage.addListener((message) => {
    void handleNativeMessage(port, message).catch(() => {
      try {
        port.postMessage({ type: "passport.error", reason: "operation_failed" });
      } catch {
        // The native host already disconnected.
      }
    });
  });
  port.onDisconnect.addListener(() => {
    if (nativePort === port) {
      nativePort = null;
      ready = false;
      signedChallengeId = null;
      browserCommands.reset();
      chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 1 });
    }
  });
  port.postMessage({
    type: "passport.hello",
    extensionOrigin: chrome.runtime.getURL(""),
    publicKeySpkiBase64: await exportPublicKeyBase64(pair),
    supportedCommands: SUPPORTED_COMMANDS,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void connect();
});
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
void connect();
