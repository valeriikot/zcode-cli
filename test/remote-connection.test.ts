import { describe, expect, test } from "bun:test";

import {
  parseRemoteConnectionUrl,
  redactRemoteConnectionUrl,
  relayWebSocketUrl
} from "../src/remote/connection-params.ts";
import { crc32, crc32Hex } from "../src/remote/crc32.ts";
import { calculateProof } from "../src/remote/proof.ts";

const deviceUrl = "https://zcode.z.ai/remote/v4?sid=SID-VALUE&hash=HASH-VALUE&t=1712345678&mid=machine-1"
  + "&name=Studio&app_version=1.2.3&theme=dark";

describe("remote-control URL parsing", () => {
  test("reads every documented parameter", () => {
    const params = parseRemoteConnectionUrl(deviceUrl);
    expect(params).toBeDefined();
    expect(params!.deviceSid).toBe("SID-VALUE");
    expect(params!.passHash).toBe("HASH-VALUE");
    expect(params!.timestamp).toBe(1712345678);
    expect(params!.deviceMid).toBe("machine-1");
    expect(params!.deviceName).toBe("Studio");
    expect(params!.appVersion).toBe("1.2.3");
    expect(params!.theme).toBe("dark");
  });

  test("requires sid, hash and an integer t", () => {
    expect(parseRemoteConnectionUrl("https://zcode.z.ai/remote/v4?hash=h&t=1")).toBeUndefined();
    expect(parseRemoteConnectionUrl("https://zcode.z.ai/remote/v4?sid=s&t=1")).toBeUndefined();
    expect(parseRemoteConnectionUrl("https://zcode.z.ai/remote/v4?sid=s&hash=h")).toBeUndefined();
    expect(parseRemoteConnectionUrl("https://zcode.z.ai/remote/v4?sid=s&hash=h&t=abc")).toBeUndefined();
    expect(parseRemoteConnectionUrl("https://zcode.z.ai/remote/v4?sid=s&hash=h&t=1.5")).toBeUndefined();
    expect(parseRemoteConnectionUrl("https://zcode.z.ai/remote/v4?sid=s&hash=h&t=")).toBeUndefined();
    expect(parseRemoteConnectionUrl("https://zcode.z.ai/remote/v4?sid=&hash=h&t=1")).toBeUndefined();
  });

  test("rejects malformed and relative input", () => {
    expect(parseRemoteConnectionUrl("")).toBeUndefined();
    expect(parseRemoteConnectionUrl("not a url")).toBeUndefined();
    expect(parseRemoteConnectionUrl("/remote/v4?sid=s&hash=h&t=1")).toBeUndefined();
    expect(parseRemoteConnectionUrl("zcode.z.ai/remote/v4?sid=s&hash=h&t=1")).toBeUndefined();
  });

  test("trims values and drops empty optional parameters", () => {
    const params = parseRemoteConnectionUrl(
      "  https://zcode.z.ai/remote/v4?sid=%20SID%20&hash=%20HASH%20&t=1&mid=&name=  "
    );
    expect(params!.deviceSid).toBe("SID");
    expect(params!.passHash).toBe("HASH");
    expect(params!.deviceMid).toBeUndefined();
    expect(params!.deviceName).toBeUndefined();
    expect(params!.theme).toBeUndefined();
  });
});

describe("relay endpoint derivation", () => {
  test("maps https to wss and carries the machine id", () => {
    const params = parseRemoteConnectionUrl("https://zcode.z.ai/remote/v4?sid=s&hash=h&t=1&mid=m");
    expect(relayWebSocketUrl(params!).toString()).toBe("wss://zcode.z.ai/ws?mid=m");
  });

  test("maps http to ws and preserves the port", () => {
    const plain = parseRemoteConnectionUrl("http://localhost:3000/remote/v4?sid=s&hash=h&t=1");
    expect(relayWebSocketUrl(plain!).toString()).toBe("ws://localhost:3000/ws");
    const secure = parseRemoteConnectionUrl("https://zcode.z.ai:8443/remote/v4?sid=s&hash=h&t=1");
    expect(relayWebSocketUrl(secure!).toString()).toBe("wss://zcode.z.ai:8443/ws");
  });

  test("omits the query when no machine id was advertised", () => {
    const params = parseRemoteConnectionUrl("https://zcode.z.ai/remote/v4?sid=s&hash=h&t=1");
    expect(relayWebSocketUrl(params!).toString()).toBe("wss://zcode.z.ai/ws");
  });

  test("treats only https and wss sources as secure", () => {
    const insecure = parseRemoteConnectionUrl("ws://zcode.z.ai/remote/v4?sid=s&hash=h&t=1");
    expect(relayWebSocketUrl(insecure!).protocol).toBe("ws:");
    const upgraded = parseRemoteConnectionUrl("wss://zcode.z.ai/remote/v4?sid=s&hash=h&t=1");
    expect(relayWebSocketUrl(upgraded!).protocol).toBe("wss:");
  });
});

describe("remote-control URL redaction", () => {
  test("removes the pass hash and truncates the device session id", () => {
    const redacted = redactRemoteConnectionUrl(deviceUrl);
    expect(redacted).not.toContain("HASH-VALUE");
    expect(redacted).not.toContain("SID-VALUE");
    expect(redacted).toContain("hash=***");
    expect(redacted).toContain("sid=SID-");
    expect(redacted).toContain("name=Studio");
  });

  test("masks a short device session id completely", () => {
    expect(redactRemoteConnectionUrl("https://zcode.z.ai/r?sid=ab&hash=h&t=1")).toContain("sid=***");
  });

  test("accepts parsed parameters and unparseable input", () => {
    const params = parseRemoteConnectionUrl(deviceUrl);
    expect(redactRemoteConnectionUrl(params!)).not.toContain("HASH-VALUE");
    expect(redactRemoteConnectionUrl("not a url")).toBe("<unparseable remote url>");
  });
});

describe("pairing proof", () => {
  // Independently computed with python hmac/hashlib for the same inputs.
  test("matches a known HMAC-SHA256 base64url vector", () => {
    expect(calculateProof({
      deviceSid: "device-sid-fixture",
      nonce: "nonce-fixture",
      passHash: "pass-hash-fixture",
      role: "terminal"
    })).toBe("UOA1QtHfunoyJbr05EIuZOMu9yE6zkiJErWetGytaEU");
  });

  test("has no base64 padding and is bound to every input", () => {
    const base = {
      deviceSid: "device-sid-fixture",
      nonce: "nonce-fixture",
      passHash: "pass-hash-fixture",
      role: "terminal"
    };
    const proof = calculateProof(base);
    expect(proof).not.toContain("=");
    expect(proof).not.toContain("+");
    expect(proof).not.toContain("/");
    expect(calculateProof({ ...base, nonce: "other" })).not.toBe(proof);
    expect(calculateProof({ ...base, role: "viewer" })).not.toBe(proof);
    expect(calculateProof({ ...base, deviceSid: "other" })).not.toBe(proof);
    expect(calculateProof({ ...base, passHash: "other" })).not.toBe(proof);
  });
});

describe("crc32", () => {
  test("matches the standard check value and known vectors", () => {
    expect(crc32Hex(new TextEncoder().encode("123456789"))).toBe("cbf43926");
    expect(crc32Hex(new TextEncoder().encode("hello"))).toBe("3610a686");
    expect(crc32Hex(new Uint8Array(0))).toBe("00000000");
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
  });

  test("stays an unsigned 32-bit value and is always eight hex digits", () => {
    for (const bytes of [new Uint8Array([0]), new Uint8Array([0xff]), new Uint8Array([1, 2, 3, 4, 5])]) {
      expect(crc32(bytes)).toBeGreaterThanOrEqual(0);
      expect(crc32(bytes)).toBeLessThanOrEqual(0xffffffff);
      expect(crc32Hex(bytes)).toHaveLength(8);
    }
  });
});
