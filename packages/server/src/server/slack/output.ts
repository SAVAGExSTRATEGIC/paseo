const CREDENTIAL_PATTERNS = [
  /\bxox[a-z]-[A-Za-z0-9-]+/gu,
  /\bxapp-[A-Za-z0-9-]+/gu,
  /\bsk-[A-Za-z0-9_-]{20,}/gu,
  /\bBearer\s+[^\s"'<>]+/giu,
  /\b(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY))\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gu,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu,
];

export function redactSlackText(text: string): string {
  let redacted = text;
  for (const pattern of CREDENTIAL_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function chunkOutput(text: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + 2900, text.length);
    const newline = text.lastIndexOf("\n", end - 1);
    if (end < text.length && newline > offset + 1400) end = newline + 1;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}
