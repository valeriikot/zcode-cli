import { createHmac } from "node:crypto";

export interface RemoteProofInput {
  deviceSid: string;
  nonce: string;
  passHash: string;
  role: string;
}

/**
 * proof = base64url_nopad(HMAC-SHA256(key: utf8(passHash), msg: utf8(`${nonce}|${role}|${deviceSid}`)))
 */
export function calculateProof(input: RemoteProofInput): string {
  return createHmac("sha256", Buffer.from(input.passHash, "utf8"))
    .update(`${input.nonce}|${input.role}|${input.deviceSid}`, "utf8")
    .digest("base64url");
}
