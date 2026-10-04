// À importer EN PREMIER (index.ts) : le thread pool de libuv est créé à sa première utilisation et
// UV_THREADPOOL_SIZE est ignoré ensuite. Il sert à crypto.scrypt (hachage des mots de passe), aux
// résolutions DNS et aux accès disque : avec le défaut de 4 threads, quelques connexions simultanées
// occupent tout le pool et retardent aussi le reste.
// En production, mieux vaut aussi le définir dans l'environnement du processus (UV_THREADPOOL_SIZE=16).
import "dotenv/config";
import os from "os";

const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;

if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = String(Math.min(32, Math.max(8, cores * 2)));
}

const threadPoolSize = Number(process.env.UV_THREADPOOL_SIZE) || 4;

// Hachages de mots de passe réellement simultanés. Toujours en dessous de la taille du pool : on garde
// au moins 2 threads libres pour le DNS, le disque, etc., même en pleine rafale de connexions.
export const HASH_CONCURRENCY =
  Number(process.env.HASH_CONCURRENCY) || Math.max(2, Math.min(cores - 1, threadPoolSize - 2));

// Au-delà, on répond 503 tout de suite plutôt que de faire attendre indéfiniment (voir utils/password.ts)
export const HASH_QUEUE_MAX = Number(process.env.HASH_QUEUE_MAX) || 400;
export const HASH_QUEUE_TIMEOUT_MS = Number(process.env.HASH_QUEUE_TIMEOUT_MS) || 8000;
