import * as crypto from 'crypto';

export function computeRequestHash(payload: any): string {
  const normalized = JSON.stringify(payload, Object.keys(payload || {}).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

let fencingCounter = 0n;
export function generateFencingToken(): bigint {
  const now = BigInt(Date.now()) * 1000n;
  fencingCounter = (fencingCounter + 1n) % 1000n;
  return now + fencingCounter;
}
