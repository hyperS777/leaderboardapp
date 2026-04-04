import { webcrypto } from 'crypto';
const { subtle } = webcrypto;

async function _hashPw(pw) {
  const enc = new TextEncoder();
  const keyMaterial = await subtle.importKey(
    "raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]
  );
  const salt = new Uint8Array([161, 178, 195, 212, 229, 246, 7, 24]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", salt: salt, iterations: 600000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

_hashPw("soeokok").then(console.log);
