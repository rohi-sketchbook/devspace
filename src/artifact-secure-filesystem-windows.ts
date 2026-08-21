import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { lstat, mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import { join, toNamespacedPath } from "node:path";
import { ArtifactError } from "./artifact-error.js";

const PARTIAL_PREFIX = ".devspace-download-";
const PARTIAL_SUFFIX = ".partial";
const STALE_PARTIAL_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_STALE_PARTIAL_CLEANUP = 32;

export interface WindowsSecureArtifactTarget {
  writeAll(buffer: Buffer, position: number): Promise<void>;
  syncAndVerify(expectedSize: number): Promise<void>;
  publish(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenWindowsArtifactTargetOptions {
  workspaceRoot: string;
  parentParts: readonly string[];
  name: string;
  publishLink: typeof import("node:fs/promises").link;
}

type FileEntry = Awaited<ReturnType<FileHandle["stat"]>>;

type KoffiLike = {
  load(path: string): { func(signature: string): unknown };
  pointer(name: string, type: unknown): unknown;
  opaque(): unknown;
  struct(name: string, fields: Record<string, string>): unknown;
  sizeof(type: unknown): number;
  address(value: unknown): bigint;
};

interface WindowsApi {
  CreateFileW(
    path: string,
    access: number,
    share: number,
    security: null,
    disposition: number,
    flags: number,
    templateFile: null,
  ): unknown;
  GetFileInformationByHandleEx(
    handle: unknown,
    infoClass: number,
    info: WindowsAttributeInfo,
    size: number,
  ): number;
  CloseHandle(handle: unknown): number;
  HANDLE: unknown;
  FILE_ATTRIBUTE_TAG_INFO: unknown;
}

interface WindowsAttributeInfo {
  FileAttributes?: number;
  ReparseTag?: number;
}

let cachedKoffi: KoffiLike | undefined;
let cachedWindowsApi: WindowsApi | undefined;

export async function openWindowsArtifactTarget({
  workspaceRoot,
  parentParts,
  name,
  publishLink,
}: OpenWindowsArtifactTargetOptions): Promise<WindowsSecureArtifactTarget> {
  const pinnedHandles: unknown[] = [];
  let fileHandle: FileHandle | undefined;
  let partialPath: string | undefined;
  let writtenEntry: FileEntry | undefined;
  let parentPath = workspaceRoot;

  try {
    pinnedHandles.push(pinWindowsDirectory(workspaceRoot, "artifact_workspace_unsafe"));
    for (const part of parentParts) {
      parentPath = join(parentPath, part);
      try {
        await mkdir(parentPath, { mode: 0o755 });
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }
      pinnedHandles.push(
        pinWindowsDirectory(parentPath, "artifact_destination_parent_unsafe"),
      );
    }

    await cleanupStalePartials(parentPath);
    partialPath = join(
      parentPath,
      `${PARTIAL_PREFIX}${randomUUID()}${PARTIAL_SUFFIX}`,
    );
    const candidatePath = join(parentPath, name);
    fileHandle = await open(
      partialPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );

    return {
      writeAll: (buffer, position) => writeAllFileHandle(fileHandle!, buffer, position),
      async syncAndVerify(expectedSize) {
        await fileHandle!.sync();
        writtenEntry = await fileHandle!.stat();
        assertWrittenEntry(writtenEntry, expectedSize);
        assertSameEntry(await lstat(partialPath!), writtenEntry, "artifact_partial_unsafe");
      },
      async publish() {
        if (!writtenEntry) throw new Error("Artifact must be verified before publication.");
        try {
          await publishLink(partialPath!, candidatePath);
          assertSameEntry(
            await lstat(candidatePath),
            writtenEntry,
            "artifact_destination_publish_failed",
          );
          await unlink(partialPath!).catch(() => undefined);
          partialPath = undefined;
        } catch (error) {
          if (isNodeError(error) && error.code === "EEXIST") throw destinationExistsError();
          throw error;
        }
      },
      async close() {
        await fileHandle?.close().catch(() => undefined);
        if (partialPath) await unlink(partialPath).catch(() => undefined);
        closeWindowsHandles(pinnedHandles);
      },
    };
  } catch (error) {
    await fileHandle?.close().catch(() => undefined);
    if (partialPath) await unlink(partialPath).catch(() => undefined);
    closeWindowsHandles(pinnedHandles);
    throw error;
  }
}

function windowsApi(): WindowsApi {
  cachedWindowsApi ??= createWindowsApi();
  return cachedWindowsApi;
}

function createWindowsApi(): WindowsApi {
  const koffi = loadKoffi();
  const kernel32 = koffi.load("kernel32.dll");
  const HANDLE = koffi.pointer("DevSpaceArtifactWindowsHandle", koffi.opaque());
  const FILE_ATTRIBUTE_TAG_INFO = koffi.struct("DevSpaceArtifactFileAttributeTagInfo", {
    FileAttributes: "uint32_t",
    ReparseTag: "uint32_t",
  });
  return {
    CreateFileW: kernel32.func(
      "DevSpaceArtifactWindowsHandle __stdcall CreateFileW(const char16_t *path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
    ) as WindowsApi["CreateFileW"],
    GetFileInformationByHandleEx: kernel32.func(
      "int __stdcall GetFileInformationByHandleEx(DevSpaceArtifactWindowsHandle handle, int infoClass, _Out_ DevSpaceArtifactFileAttributeTagInfo *info, uint32_t size)",
    ) as WindowsApi["GetFileInformationByHandleEx"],
    CloseHandle: kernel32.func(
      "int __stdcall CloseHandle(DevSpaceArtifactWindowsHandle handle)",
    ) as WindowsApi["CloseHandle"],
    HANDLE,
    FILE_ATTRIBUTE_TAG_INFO,
  };
}

function loadKoffi(): KoffiLike {
  if (cachedKoffi) return cachedKoffi;

  try {
    const localRequire = createRequire(import.meta.url);
    cachedKoffi = localRequire("koffi") as KoffiLike;
    return cachedKoffi;
  } catch {
    throw new ArtifactError(
      "artifact_windows_runtime_unavailable",
      "Windows native file download requires the local koffi runtime.",
    );
  }
}

function pinWindowsDirectory(path: string, code: string): unknown {
  const koffi = loadKoffi();
  const api = windowsApi();
  const FILE_LIST_DIRECTORY = 0x0001;
  const FILE_TRAVERSE = 0x0020;
  const FILE_READ_ATTRIBUTES = 0x0080;
  const SYNCHRONIZE = 0x00100000;
  const FILE_SHARE_READ = 0x00000001;
  const FILE_SHARE_WRITE = 0x00000002;
  const OPEN_EXISTING = 3;
  const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
  const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
  const FILE_ATTRIBUTE_TAG_INFO_CLASS = 9;

  const handle = api.CreateFileW(
    toNamespacedPath(path),
    FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    null,
    OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
    null,
  );
  const pointerBits = koffi.sizeof(api.HANDLE) * 8;
  if (
    handle === null
    || koffi.address(handle) === BigInt.asUintN(pointerBits, -1n)
  ) {
    throw new ArtifactError(code, "Artifact directory could not be pinned safely.");
  }

  const info: WindowsAttributeInfo = {};
  const success = api.GetFileInformationByHandleEx(
    handle,
    FILE_ATTRIBUTE_TAG_INFO_CLASS,
    info,
    koffi.sizeof(api.FILE_ATTRIBUTE_TAG_INFO),
  );
  const attributes = info.FileAttributes ?? 0;
  if (
    !success
    || (attributes & FILE_ATTRIBUTE_DIRECTORY) === 0
    || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0
  ) {
    api.CloseHandle(handle);
    throw new ArtifactError(
      code,
      "Artifact directory must be a real directory, not a reparse point.",
    );
  }
  return handle;
}

function closeWindowsHandles(handles: unknown[]): void {
  const api = windowsApi();
  for (const handle of handles.reverse()) api.CloseHandle(handle);
}

async function writeAllFileHandle(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesWritten <= 0) {
      throw new ArtifactError("artifact_short_write", "Native file was not fully written.");
    }
    offset += bytesWritten;
  }
}

function assertWrittenEntry(entry: FileEntry, expectedSize: number): void {
  if (!entry.isFile() || entry.size !== expectedSize) {
    throw new ArtifactError(
      "artifact_write_integrity_failed",
      "Native file could not be verified before publication.",
    );
  }
}

function assertSameEntry(
  entry: FileEntry,
  expected: FileEntry,
  code: "artifact_partial_unsafe" | "artifact_destination_publish_failed",
): void {
  if (
    entry.isSymbolicLink()
    || !entry.isFile()
    || entry.dev !== expected.dev
    || entry.ino !== expected.ino
    || entry.size !== expected.size
  ) {
    throw new ArtifactError(
      code,
      code === "artifact_partial_unsafe"
        ? "Native file partial changed before publication."
        : "Published artifact did not match the verified download.",
    );
  }
}

async function cleanupStalePartials(directoryPath: string): Promise<void> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  let inspected = 0;
  const cutoff = Date.now() - STALE_PARTIAL_AGE_MS;
  for (const entry of entries) {
    if (inspected >= MAX_STALE_PARTIAL_CLEANUP) break;
    if (!entry.name.startsWith(PARTIAL_PREFIX) || !entry.name.endsWith(PARTIAL_SUFFIX)) {
      continue;
    }
    inspected += 1;
    const path = join(directoryPath, entry.name);
    const metadata = await lstatOrUndefined(path);
    if (
      !metadata
      || metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.mtimeMs >= cutoff
      || (process.getuid?.() !== undefined && metadata.uid !== process.getuid?.())
    ) continue;
    await unlink(path).catch(() => undefined);
  }
}

function destinationExistsError(): ArtifactError {
  return new ArtifactError("artifact_destination_exists", "Artifact destination already exists.");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}
