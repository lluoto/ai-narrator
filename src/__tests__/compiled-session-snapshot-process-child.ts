import { readFileSync, readSync, writeSync } from "fs";
import { CompiledSessionSnapshotStore, compiledSessionSnapshotNodeFileOps } from "../api/compiled-session-snapshot";

const root = process.env.SNAPSHOT_PROCESS_ROOT;
const snapshotFile = process.env.SNAPSHOT_PROCESS_FILE;
if (!root || !snapshotFile) throw new Error("snapshot process root and snapshot file are required");
const maxEntries = process.env.SNAPSHOT_PROCESS_MAX_ENTRIES;
const maxBytes = process.env.SNAPSHOT_PROCESS_MAX_BYTES;

let held = false;
const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8")) as unknown;
const store = new CompiledSessionSnapshotStore({
  root,
  allowUncoordinatedTestWrites: true,
  ...(maxEntries === undefined ? {} : { maxEntries: Number(maxEntries) }),
  ...(maxBytes === undefined ? {} : { maxBytes: Number(maxBytes) }),
  fileOps: {
    ...compiledSessionSnapshotNodeFileOps,
    writeNew(path, value) {
      // This is after save() has checked the durable header/predecessor and
      // before either body or header is published.  The parent uses it to
      // reproduce the former lost-update window deterministically.
      if (!held) {
        held = true;
        writeSync(1, `${JSON.stringify({ event: "ready" })}\n`);
        readSync(0, new Uint8Array(1), 0, 1, null);
      }
      compiledSessionSnapshotNodeFileOps.writeNew(path, value);
    },
  },
});

const result = store.save(snapshot);
writeSync(1, `${JSON.stringify({ event: "result", result })}\n`);
