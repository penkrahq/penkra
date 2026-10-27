import { x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { NOISE_MAX_MESSAGE_BYTES } from "./noise";

const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const protocol = new TextEncoder().encode("Noise_N_25519_ChaChaPoly_SHA256");

/** Noise N, revision 34: responder static pre-message, then e, es and payload. */
export function sealPush(recipient: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (recipient.length !== 32 || plaintext.length + 48 > NOISE_MAX_MESSAGE_BYTES)
    throw new Error("Invalid sealed push payload.");
  const ephemeral = x25519.utils.randomSecretKey();
  let secret: Uint8Array | undefined;
  let key: Uint8Array | undefined;
  try {
    const initial =
      protocol.length <= 32
        ? concat(protocol, new Uint8Array(32 - protocol.length))
        : sha256(protocol);
    let hash = sha256(concat(initial, new Uint8Array())); // empty prologue
    hash = sha256(concat(hash, recipient));
    const publicKey = x25519.getPublicKey(ephemeral);
    hash = sha256(concat(hash, publicKey));
    secret = x25519.getSharedSecret(ephemeral, recipient);
    const temporary = hmac(sha256, initial, secret);
    const first = hmac(sha256, temporary, Uint8Array.of(1));
    key = hmac(sha256, temporary, concat(first, Uint8Array.of(2)));
    temporary.fill(0);
    first.fill(0);
    return concat(publicKey, chacha20poly1305(key, new Uint8Array(12), hash).encrypt(plaintext));
  } finally {
    ephemeral.fill(0);
    secret?.fill(0);
    key?.fill(0);
  }
}
