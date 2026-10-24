// Noise revision 34, limited to Penkra's XX pairing and KK session patterns.
import { x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { hkdf } from "@noble/hashes/hkdf.js";

const MAX_MESSAGE = 65_535;
const MAX_NONCE = (1n << 64n) - 1n;
const REKEY_MESSAGES = 2 ** 20; // Approved Noise session rekey boundary (TODO §7.2.6).
const EMPTY = new Uint8Array();
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
function nonce(value: bigint) {
  const bytes = new Uint8Array(12);
  new DataView(bytes.buffer).setBigUint64(4, value, true);
  return bytes;
}
function deriveKeys(chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const temporary = hmac(sha256, chainingKey, input);
  const first = hmac(sha256, temporary, Uint8Array.of(1));
  const second = hmac(sha256, temporary, concat(first, Uint8Array.of(2)));
  temporary.fill(0);
  return [first, second];
}

export class NoiseCipher {
  private key: Uint8Array;
  private counter = 0n;
  private messages = 0;
  private failed = false;
  constructor(
    key: Uint8Array,
    private readonly automaticRekey = true,
  ) {
    if (key.length !== 32) throw new Error("Noise requires a 32-byte key");
    this.key = new Uint8Array(key);
  }
  private crypt(input: Uint8Array, associatedData: Uint8Array, decrypt: boolean): Uint8Array {
    if (this.failed || this.counter === MAX_NONCE) throw new Error("Noise cipher is closed");
    if (input.length + (decrypt ? 0 : 16) > MAX_MESSAGE || (decrypt && input.length < 16)) {
      this.destroy();
      throw new Error("Invalid Noise message length");
    }
    try {
      const cipher = chacha20poly1305(this.key, nonce(this.counter), associatedData);
      const output = decrypt ? cipher.decrypt(input) : cipher.encrypt(input);
      this.counter += 1n;
      this.messages += 1;
      if (this.automaticRekey && this.messages === REKEY_MESSAGES) {
        this.rekey();
        this.messages = 0;
      }
      return output;
    } catch (error) {
      this.destroy();
      throw error;
    }
  }
  encrypt(plaintext: Uint8Array, associatedData: Uint8Array = EMPTY) {
    return this.crypt(plaintext, associatedData, false);
  }
  decrypt(ciphertext: Uint8Array, associatedData: Uint8Array = EMPTY) {
    return this.crypt(ciphertext, associatedData, true);
  }
  rekey() {
    if (this.failed) throw new Error("Noise cipher is closed");
    const next = chacha20poly1305(this.key, nonce(MAX_NONCE))
      .encrypt(new Uint8Array(32))
      .slice(0, 32);
    this.key.fill(0);
    this.key = next;
  }
  destroy() {
    this.key.fill(0);
    this.failed = true;
  }
}

export interface NoiseTransport {
  send: NoiseCipher;
  receive: NoiseCipher;
  handshakeHash: Uint8Array;
  remoteStaticKey: Uint8Array;
}
type Pattern = "XX" | "KK";
const PATTERNS: Record<Pattern, readonly (readonly string[])[]> = {
  XX: [["e"], ["e", "ee", "s", "es"], ["s", "se"]],
  KK: [
    ["e", "es", "ss"],
    ["e", "ee", "se"],
  ],
};
export interface NoiseHandshakeOptions {
  pattern: Pattern;
  initiator: boolean;
  staticPrivateKey: Uint8Array;
  remoteStaticKey?: Uint8Array;
  prologue: Uint8Array;
  /** Deterministic ephemeral keys for published vector checks; omitted in live sessions. */
  ephemeralPrivateKey?: Uint8Array;
}
export class NoiseHandshake {
  private staticKey: Uint8Array;
  private ephemeralKey: Uint8Array | null;
  private remoteStatic: Uint8Array | null;
  private remoteEphemeral: Uint8Array | null = null;
  private hash: Uint8Array;
  private chainingKey: Uint8Array;
  private cipher: NoiseCipher | null = null;
  private step = 0;
  private failed = false;
  private transport: NoiseTransport | null = null;
  private readonly pattern: Pattern;
  private readonly initiator: boolean;
  constructor(options: NoiseHandshakeOptions) {
    if (
      options.staticPrivateKey.length !== 32 ||
      (options.remoteStaticKey && options.remoteStaticKey.length !== 32) ||
      (options.ephemeralPrivateKey && options.ephemeralPrivateKey.length !== 32) ||
      (options.pattern === "KK" && !options.remoteStaticKey)
    )
      throw new Error("Invalid Noise identity");
    this.pattern = options.pattern;
    this.initiator = options.initiator;
    this.staticKey = new Uint8Array(options.staticPrivateKey);
    this.ephemeralKey = options.ephemeralPrivateKey
      ? new Uint8Array(options.ephemeralPrivateKey)
      : null;
    this.remoteStatic = options.remoteStaticKey ? new Uint8Array(options.remoteStaticKey) : null;
    const name = new TextEncoder().encode(`Noise_${this.pattern}_25519_ChaChaPoly_SHA256`);
    this.hash = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name);
    this.chainingKey = new Uint8Array(this.hash);
    this.mixHash(options.prologue);
    if (this.pattern === "KK") {
      const local = x25519.getPublicKey(this.staticKey);
      this.mixHash(this.initiator ? local : this.remoteStatic!);
      this.mixHash(this.initiator ? this.remoteStatic! : local);
    }
  }
  private mixHash(data: Uint8Array) {
    this.hash = sha256(concat(this.hash, data));
  }
  private mixKey(data: Uint8Array) {
    const [chainingKey, key] = deriveKeys(this.chainingKey, data);
    this.chainingKey.fill(0);
    this.chainingKey = chainingKey;
    this.cipher?.destroy();
    this.cipher = new NoiseCipher(key, false);
    key.fill(0);
    data.fill(0);
  }
  private encryptHash(data: Uint8Array) {
    const result = this.cipher ? this.cipher.encrypt(data, this.hash) : new Uint8Array(data);
    this.mixHash(result);
    return result;
  }
  private decryptHash(data: Uint8Array) {
    const result = this.cipher ? this.cipher.decrypt(data, this.hash) : new Uint8Array(data);
    this.mixHash(data);
    return result;
  }
  private dh(token: string) {
    if (token === "ee") return x25519.getSharedSecret(this.ephemeralKey!, this.remoteEphemeral!);
    if (token === "ss") return x25519.getSharedSecret(this.staticKey, this.remoteStatic!);
    const ephemeralLocal = token === "es" ? this.initiator : !this.initiator;
    return x25519.getSharedSecret(
      ephemeralLocal ? this.ephemeralKey! : this.staticKey,
      ephemeralLocal ? this.remoteStatic! : this.remoteEphemeral!,
    );
  }
  private advance() {
    this.step += 1;
    if (this.step !== PATTERNS[this.pattern].length) return;
    const [first, second] = deriveKeys(this.chainingKey, EMPTY);
    this.transport = {
      send: new NoiseCipher(this.initiator ? first : second),
      receive: new NoiseCipher(this.initiator ? second : first),
      handshakeHash: new Uint8Array(this.hash),
      remoteStaticKey: new Uint8Array(this.remoteStatic!),
    };
    first.fill(0);
    second.fill(0);
    this.chainingKey.fill(0);
    this.staticKey.fill(0);
    this.ephemeralKey?.fill(0);
    this.cipher?.destroy();
  }
  private checkTurn(writing: boolean) {
    if (this.failed || this.transport || writing !== (this.initiator === (this.step % 2 === 0))) {
      throw new Error("Invalid Noise handshake state");
    }
  }
  writeMessage(payload: Uint8Array = EMPTY): Uint8Array {
    this.checkTurn(true);
    try {
      const pieces: Uint8Array[] = [];
      for (const token of PATTERNS[this.pattern][this.step]!) {
        if (token === "e") {
          this.ephemeralKey ??= x25519.utils.randomSecretKey();
          const publicKey = x25519.getPublicKey(this.ephemeralKey);
          pieces.push(publicKey);
          this.mixHash(publicKey);
        } else if (token === "s")
          pieces.push(this.encryptHash(x25519.getPublicKey(this.staticKey)));
        else this.mixKey(this.dh(token));
      }
      pieces.push(this.encryptHash(payload));
      const message = concat(...pieces);
      if (message.length > MAX_MESSAGE) throw new Error("Noise handshake is too large");
      this.advance();
      return message;
    } catch (error) {
      this.destroy();
      throw error;
    }
  }
  readMessage(message: Uint8Array): Uint8Array {
    this.checkTurn(false);
    try {
      if (message.length > MAX_MESSAGE) throw new Error("Noise handshake is too large");
      let offset = 0;
      const take = (size: number) => {
        if (offset + size > message.length) throw new Error("Truncated Noise handshake");
        const result = message.subarray(offset, offset + size);
        offset += size;
        return result;
      };
      for (const token of PATTERNS[this.pattern][this.step]!) {
        if (token === "e") {
          this.remoteEphemeral = new Uint8Array(take(32));
          this.mixHash(this.remoteEphemeral);
        } else if (token === "s") this.remoteStatic = this.decryptHash(take(this.cipher ? 48 : 32));
        else this.mixKey(this.dh(token));
      }
      const payload = this.decryptHash(message.subarray(offset));
      this.advance();
      return payload;
    } catch (error) {
      this.destroy();
      throw error;
    }
  }
  finish(): NoiseTransport {
    if (this.failed || !this.transport) throw new Error("Noise handshake is not complete");
    return this.transport;
  }
  destroy() {
    this.failed = true;
    this.staticKey.fill(0);
    this.ephemeralKey?.fill(0);
    this.chainingKey.fill(0);
    this.cipher?.destroy();
    this.transport?.send.destroy();
    this.transport?.receive.destroy();
  }
}

export const createNoiseIdentity = () => x25519.utils.randomSecretKey();
export const noisePublicKey = (privateKey: Uint8Array) => x25519.getPublicKey(privateKey);
export function noisePairingCode(handshakeHash: Uint8Array): string {
  if (handshakeHash.length !== 32) throw new Error("Invalid Noise handshake hash");
  const bytes = hkdf(sha256, handshakeHash, EMPTY, new TextEncoder().encode("penkra-sas"), 32);
  return String(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) % 1_000_000,
  ).padStart(6, "0");
}
