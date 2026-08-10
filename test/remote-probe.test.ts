import { describe, expect, test } from "bun:test";

import { probeRemoteDevice } from "../src/remote/client.ts";
import { parseRemoteConnectionUrl, redactRemoteConnectionUrl } from "../src/remote/connection-params.ts";

/**
 * End-to-end probe against a real paired ZCode desktop. It needs a live remote-control URL, so it
 * is opt-in: set `ZCODE_REMOTE_PROBE_URL` to run it. The URL is a device credential and is only ever
 * reported in its redacted form.
 */
const probeUrl = process.env.ZCODE_REMOTE_PROBE_URL?.trim();
const params = probeUrl === undefined || probeUrl.length === 0
  ? undefined
  : parseRemoteConnectionUrl(probeUrl);

describe("live remote desktop probe", () => {
  test.skipIf(params === undefined)("pairs with the desktop and lists its workspaces", async () => {
    const lines: string[] = [];
    const snapshot = await probeRemoteDevice(params!, {
      onLog: (line) => lines.push(line),
      pairingTimeoutMs: 60_000
    });
    // eslint-disable-next-line no-console
    console.log(`probe ${redactRemoteConnectionUrl(params!)} -> ${JSON.stringify(snapshot)}`);
    expect(snapshot.paired).toBe(true);
    expect(snapshot.state).toBe("paired");
    expect(Array.isArray(snapshot.workspaces)).toBe(true);
    expect(lines.join("\n")).not.toContain(params!.passHash);
    expect(lines.join("\n")).not.toContain(params!.deviceSid);
  }, 120_000);

  test.skipIf(params !== undefined)("is skipped without ZCODE_REMOTE_PROBE_URL", () => {
    expect(params).toBeUndefined();
  });
});
