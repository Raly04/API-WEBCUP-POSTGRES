import crypto from "crypto";

// TOTP (RFC 6238) au-dessus de HOTP (RFC 4226), implémenté ici plutôt qu'avec une dépendance :
// l'algorithme tient en une centaine de lignes et ne touche qu'à crypto, déjà utilisé ailleurs
// (utils/token.ts). Compatible Google Authenticator, Authy, 1Password... (SHA1, 6 chiffres, 30 s).
const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1; // tolère ±30 s de dérive d'horloge entre le téléphone et le serveur

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateBase32Secret(bytes = 20): string {
  const buffer = crypto.randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  // Le compteur tient largement sur 32 bits (30 s de pas => dépasse l'an 10 000), mais la RFC impose 8 octets
  counterBuffer.writeUInt32BE(counter, 4);
  const hmac = crypto.createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const truncated =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(truncated % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function buildOtpauthUrl(secret: string, email: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Un même code ne doit jamais valider deux connexions : lastCounter mémorise le pas déjà utilisé
// (colonne users.two_factor_last_counter), et toute tentative sur ce pas ou un pas antérieur est
// refusée, même si le code est par ailleurs arithmétiquement correct (rejeu d'un code intercepté).
export function verifyTotp(encodedSecret: string, code: string, lastCounter: number | null): { valid: boolean; counter: number } {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) return { valid: false, counter: -1 };
  const secret = base32Decode(encodedSecret);
  const currentCounter = Math.floor(Date.now() / 1000 / STEP_SECONDS);

  for (let delta = -WINDOW; delta <= WINDOW; delta++) {
    const counter = currentCounter + delta;
    if (lastCounter !== null && counter <= lastCounter) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, counter)), Buffer.from(trimmed))) {
      return { valid: true, counter };
    }
  }
  return { valid: false, counter: -1 };
}

// Alphabet sans caractères ambigus (0/O, 1/I/L) : un code recopié à la main se relit sans erreur
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRecoveryCode(): string {
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
    if (i === 3) code += "-";
  }
  return code;
}

export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, generateRecoveryCode);
}
