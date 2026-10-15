import { endianness } from "node:os";

const HEADER_BYTES = 4;
const MAX_HOST_TO_CHROME_BYTES = 1024 * 1024;
const MAX_CHROME_TO_HOST_BYTES = 32 * 1024 * 1024;

function readLength(buffer: Buffer): number {
  return endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
}

function writeLength(buffer: Buffer, length: number): void {
  if (endianness() === "LE") buffer.writeUInt32LE(length, 0);
  else buffer.writeUInt32BE(length, 0);
}

export function encodeNativeMessage(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_HOST_TO_CHROME_BYTES) {
    throw new Error("Native browser message exceeds Chrome's output limit");
  }
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  writeLength(frame, payload.length);
  payload.copy(frame, HEADER_BYTES);
  return frame;
}

export class NativeMessageDecoder {
  private remaining = Buffer.alloc(0);

  public constructor(private readonly onMessage: (message: unknown) => void) {}

  public push(chunk: Buffer): void {
    if (this.remaining.length + chunk.length > MAX_CHROME_TO_HOST_BYTES + HEADER_BYTES) {
      throw new Error("Native browser input exceeds relay limit");
    }
    this.remaining = Buffer.concat([this.remaining, chunk]);
    while (this.remaining.length >= HEADER_BYTES) {
      const length = readLength(this.remaining);
      if (length === 0 || length > MAX_CHROME_TO_HOST_BYTES) {
        throw new Error("Invalid native browser message length");
      }
      if (this.remaining.length < HEADER_BYTES + length) return;
      const payload = this.remaining.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.remaining = this.remaining.subarray(HEADER_BYTES + length);
      this.onMessage(JSON.parse(payload.toString("utf8")) as unknown);
    }
  }

  public finish(): void {
    if (this.remaining.length !== 0) throw new Error("Truncated native browser message");
  }
}
