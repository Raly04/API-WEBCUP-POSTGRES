// Cache mémoire de lectures identiques pour tous les utilisateurs (liste des services, annonces publiées...).
// Sous forte affluence, des milliers d'habitants demandent les mêmes données : une seule requête SQL suffit.
//
// - Coalescence : si 100 requêtes arrivent pendant que la donnée se charge, elles attendent la même requête
//   SQL au lieu d'en lancer 100 (évite la ruée sur la base quand le cache vient d'expirer).
// - Invalidation : toute modification appelle invalidate("préfixe") ; le TTL n'est qu'un filet de sécurité
//   (nécessaire si l'API tourne en plusieurs instances : l'invalidation reste locale à chaque instance).
// - Une erreur de chargement n'est jamais mise en cache.

interface Entry {
  value: unknown;
  expiresAt: number;
}

const MAX_ENTRIES = 500;
const store = new Map<string, Entry>();
const inFlight = new Map<string, Promise<unknown>>();
// Évite qu'un chargement lancé AVANT une invalidation ne réécrive dans le cache une donnée devenue périmée
let generation = 0;

// RESPONSE_CACHE=off : désactive le cache (diagnostic d'une donnée qui paraît périmée, comparaison de performances)
const DISABLED = (process.env.RESPONSE_CACHE || "").toLowerCase() === "off";

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  if (DISABLED) return load();
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const startedAt = generation;
  const promise: Promise<T> = load()
    .then((value) => {
      if (startedAt === generation) {
        if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value!);
        store.set(key, { value, expiresAt: Date.now() + ttlMs });
      }
      return value;
    })
    .finally(() => {
      // Après une invalidation, une requête plus récente a pu prendre la place : on ne la retire pas
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

// Supprime toutes les entrées dont la clé commence par `prefix` (ex. "services:")
export function invalidate(prefix: string) {
  generation++;
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
  for (const key of inFlight.keys()) if (key.startsWith(prefix)) inFlight.delete(key);
}
