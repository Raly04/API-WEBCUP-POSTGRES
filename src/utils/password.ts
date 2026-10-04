import bcrypt from "bcryptjs";
import crypto from "crypto";
import { HASH_CONCURRENCY, HASH_QUEUE_MAX, HASH_QUEUE_TIMEOUT_MS } from "../config/runtime";
import { OverloadedError } from "./overload";

// scrypt natif (libuv thread pool) : ~10x plus rapide que bcryptjs coût 12 et ne bloque pas la boucle d'événements.
// Format : scrypt$N$r$p$salt$hash (base64). Les anciens hashes bcrypt ($2...) restent vérifiables.
const N = 2 ** 14; // réglage "interactif" de scrypt (~16 Mo, ~85 ms) : login sous la barre des 200 ms
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAXMEM = 64 * 1024 * 1024; // 128 * N * R = 16 Mo : marge confortable (les anciens hashes à N=2^15 passent aussi)

// Au plus HASH_CONCURRENCY hachages à la fois, les autres font la queue (FIFO). Sans cela, une rafale de
// connexions occupe tout le thread pool de libuv et ralentit même les requêtes qui n'ont rien à voir.
// La file est bornée : au-delà de HASH_QUEUE_MAX, ou après HASH_QUEUE_TIMEOUT_MS d'attente, on répond 503
// tout de suite (le client réessaie) plutôt que de faire patienter jusqu'à l'expiration de son navigateur.
interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

let activeHashes = 0;
const waiting: Waiter[] = [];

function releaseSlot() {
  const next = waiting.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(); // le créneau est transmis tel quel au suivant : activeHashes ne change pas
  } else {
    activeHashes--;
  }
}

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeHashes < HASH_CONCURRENCY) {
    activeHashes++;
  } else {
    if (waiting.length >= HASH_QUEUE_MAX) throw new OverloadedError();
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          waiting.splice(waiting.indexOf(waiter), 1);
          reject(new OverloadedError());
        }, HASH_QUEUE_TIMEOUT_MS),
      };
      waiting.push(waiter);
    });
  }
  try {
    return await task();
  } finally {
    releaseSlot();
  }
}

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return withSlot(
    () =>
      new Promise<Buffer>((resolve, reject) =>
        crypto.scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)))
      )
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith("$2")) return bcrypt.compare(password, stored);

  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Hash factice : même temps de réponse si l'email n'existe pas (évite de révéler quels emails existent)
export const DUMMY_HASH_PROMISE = hashPassword("dummy-password");
