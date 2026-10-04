// Cache mémoire court de { compte actif, permissions } par utilisateur.
// Évite 2 requêtes SQL à chaque appel protégé. Toute modification de droits l'invalide :
// invalidateUser pour un utilisateur, clearAccessCache quand un rôle ou une permission change (impact multi-utilisateurs).
// TTL court : filet de sécurité si une modification passe par SQL direct.
export interface Access {
  isActive: boolean;
  permissions: string[];
  // Faux seulement pour un agent qui s'est inscrit seul et n'a pas été validé par un administrateur (voir utils/staffAccess)
  validatedStaff: boolean;
}

const TTL_MS = 30_000;
const MAX_ENTRIES = 5_000;
const cache = new Map<number, { access: Access; expiresAt: number }>();

export function getCachedAccess(userId: number): Access | null {
  const entry = cache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(userId);
    return null;
  }
  return entry.access;
}

export function setCachedAccess(userId: number, access: Access) {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!); // éviction du plus ancien
  cache.set(userId, { access, expiresAt: Date.now() + TTL_MS });
}

export function invalidateUser(userId: number) {
  cache.delete(userId);
}

export function clearAccessCache() {
  cache.clear();
}
