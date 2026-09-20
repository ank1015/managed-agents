export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, "0")).join("");
}
export async function verifySignature(secret: string, signature: string, data: string): Promise<boolean> {
  if (!/^v1=[0-9a-f]{64}$/.test(signature)) return false;
  const bytes = Uint8Array.from(signature.slice(3).match(/../g)!, byte => parseInt(byte, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(data));
}
