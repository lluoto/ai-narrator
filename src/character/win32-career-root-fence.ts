/**
 * The file-backed Career root fence needs a process-liveness proof before a
 * crashed writer's leaf can be reclaimed.  Node's process APIs deliberately
 * do not expose creation FILETIMEs, and PID alone is vulnerable to reuse, so
 * this small private adapter calls only the required kernel32 primitives.
 *
 * Nothing here is an authority by itself: callers still pin and compare the
 * filesystem object before unlinking.  This adapter merely supplies the
 * Windows-local mutex and PID+creation-time observation required to decide
 * whether the former owner can no longer own that exact leaf.
 */

import { createHash } from "crypto";
import * as path from "path";
import { dlopen, type Pointer } from "bun:ffi";

const DRIVE_FIXED = 3;
const WAIT_OBJECT_0 = 0;
const WAIT_ABANDONED = 0x80;
const WAIT_TIMEOUT = 0x102;
const ERROR_INVALID_PARAMETER = 87;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const STILL_ACTIVE = 259;

export interface CareerRootLockOwner {
  pid: number;
  /** Unsigned decimal FILETIME, never a wall-clock approximation. */
  creationFiletime: string;
}

export type CareerRootOwnerStatus = "live" | "exited-or-reused" | "unknown";

interface HeldMutex {
  readonly state: "acquired" | "abandoned";
  release(): void;
}

export type CareerRootFenceAttempt =
  | { readonly kind: "held"; readonly mutex: HeldMutex; readonly currentOwner: CareerRootLockOwner }
  | { readonly kind: "busy" }
  /** Windows was selected but the required kernel proof could not be made. */
  | { readonly kind: "unavailable" }
  /** Non-Windows, non-fixed, or non-drive roots retain fail-closed stale locks. */
  | { readonly kind: "unsupported" };

interface Kernel32 {
  /** Keep Bun's dlopen Library alive for every callable symbol below. */
  readonly library: { close(): void };
  readonly GetCurrentProcessId: () => number;
  readonly OpenProcess: (access: number, inherit: boolean, processId: number) => Pointer | null;
  readonly GetProcessTimes: (
    process: Pointer,
    creation: Uint8Array,
    exit: Uint8Array,
    kernel: Uint8Array,
    user: Uint8Array,
  ) => number;
  readonly GetExitCodeProcess: (process: Pointer, exitCode: Uint8Array) => number;
  readonly GetDriveTypeW: (rootPath: Uint8Array) => number;
  readonly CreateMutexW: (attributes: null, initialOwner: number, name: Uint8Array) => Pointer | null;
  readonly WaitForSingleObject: (handle: Pointer, milliseconds: number) => number;
  readonly ReleaseMutex: (handle: Pointer) => number;
  readonly CloseHandle: (handle: Pointer) => number;
  readonly GetLastError: () => number;
}

let kernel32: Kernel32 | null | undefined;

function utf16z(value: string): Uint8Array {
  return Buffer.from(`${value}\0`, "utf16le");
}

function readFiletime(value: Uint8Array): string | undefined {
  if (value.byteLength !== 8) return undefined;
  const filetime = new DataView(value.buffer, value.byteOffset, value.byteLength).getBigUint64(0, true);
  return filetime > 0n ? filetime.toString(10) : undefined;
}

function loadKernel32(): Kernel32 | null {
  if (kernel32 !== undefined) return kernel32;
  if (process.platform !== "win32") return kernel32 = null;
  try {
    // Retain the Library object, not merely its symbols. We intentionally do
    // not close kernel32 for process lifetime: a future Bun implementation is
    // free to make symbol validity depend on the Library's reachability.
    const library = dlopen("kernel32.dll", {
      GetCurrentProcessId: { args: [], returns: "u32" },
      OpenProcess: { args: ["u32", "bool", "u32"], returns: "ptr" },
      GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
      GetExitCodeProcess: { args: ["ptr", "ptr"], returns: "u32" },
      GetDriveTypeW: { args: ["ptr"], returns: "u32" },
      CreateMutexW: { args: ["ptr", "u32", "ptr"], returns: "ptr" },
      WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
      ReleaseMutex: { args: ["ptr"], returns: "u32" },
      CloseHandle: { args: ["ptr"], returns: "u32" },
      GetLastError: { args: [], returns: "u32" },
    });
    const symbols = library.symbols as unknown as Omit<Kernel32, "library">;
    kernel32 = { library, ...symbols };
  } catch {
    kernel32 = null;
  }
  return kernel32;
}

function closeHandle(kernel: Kernel32, handle: Pointer): void {
  try { kernel.CloseHandle(handle); } catch { /* The caller remains fail-closed. */ }
}

function currentOwner(kernel: Kernel32): CareerRootLockOwner | undefined {
  const pid = kernel.GetCurrentProcessId();
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) return undefined;
  const handle = kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!handle) return undefined;
  try {
    const creation = new Uint8Array(8);
    const ignored = new Uint8Array(8);
    if (kernel.GetProcessTimes(handle, creation, ignored, ignored, ignored) === 0) return undefined;
    const creationFiletime = readFiletime(creation);
    return creationFiletime === undefined ? undefined : { pid, creationFiletime };
  } catch {
    return undefined;
  } finally {
    closeHandle(kernel, handle);
  }
}

function rootVolumeKind(kernel: Kernel32, root: string): "fixed" | "unsupported" | "unknown" {
  const volumeRoot = path.parse(path.resolve(root)).root;
  // UNC and namespace paths are deliberately excluded: their server-side
  // identity and mutex scope are not established by this local-kernel proof.
  if (!/^[A-Za-z]:\\$/.test(volumeRoot)) return "unsupported";
  try {
    return kernel.GetDriveTypeW(utf16z(volumeRoot)) === DRIVE_FIXED ? "fixed" : "unsupported";
  } catch {
    return "unknown";
  }
}

function mutexName(root: string): string {
  const normalized = path.resolve(root).toLowerCase();
  const digest = createHash("sha256").update(Buffer.from(normalized, "utf16le")).digest("hex");
  // Global makes the fence cover independently started host processes. A
  // failure to create it is unsupported, never a reason to weaken recovery.
  return `Global\\ai-rpg-career-root-${digest}`;
}

/**
 * Acquires the non-blocking kernel fence for the entire root operation.
 * Waiting is intentionally zero-duration: a paused owner must remain fenced,
 * not turn recovery into an unbounded server request.
 */
export function tryAcquireCareerRootFence(root: string): CareerRootFenceAttempt {
  if (process.platform !== "win32") return { kind: "unsupported" };
  const kernel = loadKernel32();
  if (!kernel) return { kind: "unavailable" };
  const volume = rootVolumeKind(kernel, root);
  if (volume === "unsupported") return { kind: "unsupported" };
  if (volume === "unknown") return { kind: "unavailable" };
  let handle: Pointer | null = null;
  try {
    handle = kernel.CreateMutexW(null, 0, utf16z(mutexName(root)));
    if (!handle) return { kind: "unavailable" };
    const wait = kernel.WaitForSingleObject(handle, 0);
    if (wait === WAIT_TIMEOUT) {
      closeHandle(kernel, handle);
      return { kind: "busy" };
    }
    if (wait !== WAIT_OBJECT_0 && wait !== WAIT_ABANDONED) {
      closeHandle(kernel, handle);
      return { kind: "unavailable" };
    }
    const owner = currentOwner(kernel);
    if (!owner) {
      try { kernel.ReleaseMutex(handle); } finally { closeHandle(kernel, handle); }
      return { kind: "unavailable" };
    }
    let released = false;
    return {
      kind: "held",
      currentOwner: owner,
      mutex: {
        state: wait === WAIT_ABANDONED ? "abandoned" : "acquired",
        release: (): void => {
          if (released) return;
          released = true;
          try {
            if (kernel.ReleaseMutex(handle!) === 0) throw new Error("could not release Career root mutex");
          } finally {
            closeHandle(kernel, handle!);
          }
        },
      },
    };
  } catch {
    if (handle) closeHandle(kernel, handle);
    return { kind: "unavailable" };
  }
}

/**
 * Distinguishes a still-live exact process from a dead owner or a reused PID.
 * Access denied, any FFI error, and incomplete process metadata stay unknown.
 */
export function inspectCareerRootLockOwner(owner: CareerRootLockOwner): CareerRootOwnerStatus {
  const kernel = loadKernel32();
  if (!kernel || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 0xffff_ffff) return "unknown";
  if (!/^[1-9][0-9]{0,19}$/.test(owner.creationFiletime)) return "unknown";
  let expectedCreation: bigint;
  try { expectedCreation = BigInt(owner.creationFiletime); } catch { return "unknown"; }
  if (expectedCreation <= 0n || expectedCreation > 0xffff_ffff_ffff_ffffn) return "unknown";

  let handle: Pointer | null = null;
  try {
    handle = kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, owner.pid);
    if (!handle) return kernel.GetLastError() === ERROR_INVALID_PARAMETER ? "exited-or-reused" : "unknown";
    const creation = new Uint8Array(8);
    const ignored = new Uint8Array(8);
    if (kernel.GetProcessTimes(handle, creation, ignored, ignored, ignored) === 0) return "unknown";
    const actualCreation = readFiletime(creation);
    if (!actualCreation) return "unknown";
    if (actualCreation !== owner.creationFiletime) return "exited-or-reused";
    const exitCode = new Uint8Array(4);
    if (kernel.GetExitCodeProcess(handle, exitCode) === 0) return "unknown";
    return new DataView(exitCode.buffer, exitCode.byteOffset, exitCode.byteLength).getUint32(0, true) === STILL_ACTIVE
      ? "live"
      : "exited-or-reused";
  } catch {
    return "unknown";
  } finally {
    if (handle) closeHandle(kernel, handle);
  }
}
