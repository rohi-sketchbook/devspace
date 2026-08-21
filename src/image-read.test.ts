import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectImageMimeType,
  readImageForMcp,
} from "./image-read.js";

assert.equal(
  detectImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/png",
);
assert.equal(detectImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xdb])), "image/jpeg");
assert.equal(detectImageMimeType(Buffer.from("GIF89a", "ascii")), "image/gif");
assert.equal(
  detectImageMimeType(Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("WEBP", "ascii"),
  ])),
  "image/webp",
);
assert.equal(detectImageMimeType(Buffer.from("not-an-image", "ascii")), undefined);

const root = await mkdtemp(join(tmpdir(), "devspace-image-read-test-"));
try {
  const pngPath = join(root, "reference.png");
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00,
  ]);
  await writeFile(pngPath, pngBytes);

  const result = await readImageForMcp(pngPath);
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.bytes, pngBytes.length);
  assert.equal(Buffer.from(result.data, "base64").compare(pngBytes), 0);

  await assert.rejects(
    () => readImageForMcp(pngPath, pngBytes.length - 1),
    /safety limit/,
  );

  const textPath = join(root, "fake.png");
  await writeFile(textPath, "plain text");
  await assert.rejects(
    () => readImageForMcp(textPath),
    /Unsupported image format/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("image-read tests passed");
