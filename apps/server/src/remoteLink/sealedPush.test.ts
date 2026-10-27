import { x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { expect, it } from "vitest";
import { sealPush } from "./sealedPush";

const cat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
function open(recipient: Uint8Array, message: Uint8Array) {
  const protocol = new TextEncoder().encode("Noise_N_25519_ChaChaPoly_SHA256");
  const initial = cat(protocol, new Uint8Array(32 - protocol.length));
  const publicKey = x25519.getPublicKey(recipient);
  const ephemeral = message.slice(0, 32);
  const hash = sha256(cat(sha256(cat(sha256(initial), publicKey)), ephemeral));
  const temporary = hmac(sha256, initial, x25519.getSharedSecret(recipient, ephemeral));
  const first = hmac(sha256, temporary, Uint8Array.of(1));
  const key = hmac(sha256, temporary, cat(first, Uint8Array.of(2)));
  return chacha20poly1305(key, new Uint8Array(12), hash).decrypt(message.slice(32));
}

it("only the intended phone can open a sealed push and tampering fails", () => {
  const phone = x25519.utils.randomSecretKey(),
    other = x25519.utils.randomSecretKey();
  const text = new TextEncoder().encode('{"threadId":"thread","title":"Private"}');
  const message = sealPush(x25519.getPublicKey(phone), text);
  expect(open(phone, message)).toEqual(text);
  expect(() => open(other, message)).toThrow();
  message[message.length - 1]! ^= 1;
  expect(() => open(phone, message)).toThrow();
});
