import { readFile, stat } from "node:fs/promises";

export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type SupportedImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

export interface ReadImageResult {
  data: string;
  mimeType: SupportedImageMimeType;
  bytes: number;
}

export function detectImageMimeType(bytes: Uint8Array): SupportedImageMimeType | undefined {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (bytes.length >= 6) {
    const signature = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") {
      return "image/gif";
    }
  }

  if (
    bytes.length >= 12
    && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF"
    && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  return undefined;
}

export async function readImageForMcp(
  absolutePath: string,
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
): Promise<ReadImageResult> {
  const info = await stat(absolutePath);
  if (!info.isFile()) {
    throw new Error("Image path is not a file.");
  }
  if (info.size <= 0) {
    throw new Error("Image file is empty.");
  }
  if (info.size > maxBytes) {
    throw new Error(`Image file exceeds the ${maxBytes} byte safety limit.`);
  }

  const bytes = await readFile(absolutePath);
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) {
    throw new Error("Unsupported image format. Supported formats: PNG, JPEG, WebP, GIF.");
  }

  return {
    data: bytes.toString("base64"),
    mimeType,
    bytes: bytes.length,
  };
}
