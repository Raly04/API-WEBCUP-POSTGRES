import { NextFunction, Request, Response } from "express";

interface Entry {
  body: unknown;
  expiresAt: number;
}

const MAX_ENTRIES = 200;

// Cache des routes publiques (catalogue des services, annonces) : des milliers d'habitants qui ouvrent la
// page d'accueil au même moment ne déclenchent qu'une requête SQL par fenêtre de `seconds`.
// - Cache mémoire du serveur : absorbe les pics, quel que soit le client.
// - Cache-Control : le navigateur et un éventuel CDN/proxy gardent aussi la réponse, et peuvent la
//   resservir pendant `stale-while-revalidate` si l'API est lente ou indisponible.
// Ne s'applique qu'aux GET sans session : jamais de donnée propre à un utilisateur ici.
export function publicCache(seconds: number) {
  const store = new Map<string, Entry>();

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") return next();

    res.setHeader("Cache-Control", `public, max-age=${seconds}, stale-while-revalidate=${seconds * 10}`);

    const key = req.originalUrl;
    const hit = store.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      res.setHeader("X-Cache", "HIT");
      return res.json(hit.body);
    }

    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode === 200) {
        // Borne la mémoire : une clé par page demandée, les plus anciennes sortent en premier
        if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value as string);
        store.set(key, { body, expiresAt: Date.now() + seconds * 1000 });
      }
      return json(body);
    };
    next();
  };
}
