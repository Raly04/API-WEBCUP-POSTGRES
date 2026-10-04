# API Terra Nova — WebCup 24h

API REST (Express 5 + TypeScript + Sequelize + PostgreSQL) : comptes utilisateurs, authentification JWT, gestion des rôles / permissions (RBAC), services municipaux et annonces.

- [Démarrage](#démarrage)
- [Conventions](#conventions)
- [Authentification côté front](#authentification-côté-front)
- [Objets retournés](#objets-retournés)
- [Endpoints](#endpoints)
  - [Santé](#santé) · [Auth](#auth--apiauth) · [Utilisateurs](#utilisateurs--apiusers) · [Rôles](#rôles--apiroles) · [Permissions](#permissions--apipermissions) · [Services municipaux](#services-municipaux--apiservices) · [Annonces](#annonces--apiannouncements) · [Messages de contact](#messages-de-contact--apicontact-messages) · [Demandes citoyennes](#demandes-citoyennes--apirequests) · [Signalements](#signalements-urgences-et-incidents--apisignalements) · [Audit](#journal-daudit--apiaudit-logs) · [Sécurité web](#sécurité-web) · [Anti-robots](#protection-anti-robots)
- [Matrice rôles / permissions](#matrice-rôles--permissions)
- [Structure du projet](#structure-du-projet)

---

## Démarrage

```bash
npm install
cp .env.example .env     # puis renseigner DB_* et JWT_ACCESS_SECRET
npm run dev              # nodemon + tsx
npm run build && npm start
```

Le schéma est créé par des scripts SQL, pas par l'API :

| Script | Contenu |
|---|---|
| Blocs 1 et 2 (fournis par l'équipe) | `users`, `auth_tokens`, `audit_logs`, `roles`, `role_user`, `permissions`, `role_permission` + insertion des 3 rôles et des 9 permissions de base |
| [sql/03_metier_services_annonces.sql](sql/03_metier_services_annonces.sql) | `municipal_services`, `announcements` + permissions `admin.services.manage` et `agent.announcements.manage` (idempotent, rejouable) |
| [sql/04_seed_services.sql](sql/04_seed_services.sql) | Seed : 12 services municipaux de Terra Nova (état civil, eau et énergie, transports, santé, sécurité, logement, environnement, éducation, commerce et emploi, culture, communications, Haut Conseil). `INSERT IGNORE` sur le `code` : rejouable sans écraser les modifications faites ensuite par un administrateur |

À exécuter dans l'ordre sur chaque base (local, équipe, production). Sans le rôle `citizen` en base, l'inscription répond 500.

### Seed automatique au démarrage

À chaque démarrage (`npm run dev` ou `npm start`), l'API crée ce qui manque : les 3 rôles (`citizen`, `agent`, `admin`), les 11 permissions et leurs liaisons, puis les 12 services municipaux. Le journal affiche `[SEED] Données de base créées : …` ou `déjà en place`. Le même code se lance sans démarrer le serveur avec `npm run db:seed`.

Il ne défait jamais les réglages faits ensuite par un administrateur :
- une liaison rôle ↔ permission n'est posée que si le rôle ou la permission vient d'être créé : un droit retiré via l'API le reste au redémarrage ;
- les services ne sont semés que si la table `municipal_services` est **vide** : un service supprimé ou modifié n'est ni recréé ni écrasé.

Les tables elles-mêmes restent créées par les scripts SQL : le seed ne fait que remplir.

| Variable | Rôle |
|---|---|
| `PORT` | Port HTTP (5000 par défaut) |
| `CLIENT_URL` | Origines CORS autorisées, séparées par des virgules (ex. `http://localhost:3000`) |
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` | Connexion PostgreSQL (`DATABASE_URL`, ou `DB_*` en repli) |
| `JWT_ACCESS_SECRET` | Secret de signature des access tokens (obligatoire) |
| `JWT_ACCESS_EXPIRES_IN` | Durée de l'access token (`15m`, `1h`…) |
| `REFRESH_TOKEN_EXPIRES_DAYS` | Durée du refresh token, en jours (nombre entier, ex. `10`) |
| `AUDIT_REQUESTS` | Audit automatique des requêtes : `all` (défaut), `writes` (écritures et refus 401/403 seulement) ou `off` |
| `SEED_ON_START` | `false` désactive le seed automatique au démarrage (voir ci-dessous). Activé par défaut |
| `EXPOSE_ERRORS` | `true` : les 500 contiennent la cause. Débogage uniquement |

URL de base : `http://localhost:5000/api`

## Conventions

- Corps des requêtes et réponses en **JSON** (`Content-Type: application/json`).
- Les ids sont des **entiers**. Les dates sont en **ISO 8601 UTC** (`2026-10-03T11:14:47.608Z`).
- Toute erreur renvoie `{ "message": "..." }` avec le bon code HTTP :

| Code | Signification |
|---|---|
| 400 | Données invalides (le message précise le champ) |
| 401 | Non authentifié : token absent, invalide, expiré, ou compte désactivé |
| 403 | Authentifié mais permission manquante |
| 404 | Ressource ou route introuvable |
| 409 | Conflit (email, code de rôle ou de permission déjà pris, suppression impossible) |
| 429 | Trop de requêtes (limitation de débit) ou adresse temporairement bloquée par la protection anti-robots (`code: "bot_blocked"`) : attendre `Retry-After` secondes |
| 500 | Erreur serveur |
| 503 | Serveur momentanément saturé ou base de données indisponible : réessayer après `Retry-After` secondes. Aucune donnée n'a été modifiée |

- **Pagination** (`users`, `audit-logs`) : `?page=1&limit=20` (limit max 100). La réponse contient `page`, `limit`, `total`.
- Les routes marquées 🔒 exigent le header `Authorization: Bearer <accessToken>`. Les routes marquées 🛡️ exigent en plus la permission `admin.users.manage`. Les routes avec une autre permission l'indiquent explicitement.

## Authentification côté front

Deux tokens sont renvoyés à l'inscription, à la connexion et au refresh :

| Token | Durée | Usage |
|---|---|---|
| `accessToken` (JWT) | courte (`JWT_ACCESS_EXPIRES_IN`) | Header `Authorization: Bearer …` sur chaque appel 🔒 |
| `refreshToken` (opaque) | longue (`REFRESH_TOKEN_EXPIRES_DAYS`) | Obtenir un nouvel access token via `POST /auth/refresh` |

Le refresh token est **aussi posé dans un cookie `httpOnly`** (`refreshToken`, chemin `/api/auth`). Pour un front web, ne le stockez pas : laissez le cookie, et appelez `/auth/refresh` et `/auth/logout` avec `credentials: "include"`. Hors navigateur (Postman, mobile), envoyez-le dans le body : `{ "refreshToken": "..." }`.

**Rotation** : chaque refresh token n'est utilisable qu'**une seule fois**. `/auth/refresh` en renvoie un nouveau, qu'il faut conserver à la place de l'ancien. Deux refresh simultanés avec le même token : un seul réussit.

Le front peut afficher l'interface selon `user.roles` et `user.permissions`, renvoyés à chaque connexion et par `/auth/me`. Le serveur re-vérifie toujours les droits à chaque requête.

```js
const API = "http://localhost:5000/api";
let accessToken = null;

async function api(path, options = {}, retry = true) {
  const res = await fetch(API + path, {
    ...options,
    credentials: "include", // envoie le cookie refreshToken
    headers: {
      "Content-Type": "application/json",
      ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
      ...options.headers,
    },
  });
  // Access token expiré : on le renouvelle une fois puis on rejoue la requête
  if (res.status === 401 && retry && path !== "/auth/refresh" && path !== "/auth/login") {
    const refresh = await fetch(API + "/auth/refresh", { method: "POST", credentials: "include" });
    if (refresh.ok) {
      accessToken = (await refresh.json()).accessToken;
      return api(path, options, false);
    }
    accessToken = null; // session perdue : renvoyer vers la page de connexion
  }
  return res;
}

// Connexion
const res = await api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
const { user, accessToken: token } = await res.json();
accessToken = token;
```

## Objets retournés

### User

```json
{
  "id": 3,
  "email": "awa@example.com",
  "firstName": "Awa",
  "lastName": "Diallo",
  "phone": "+2250102030405",
  "address": "12 rue des Dômes, Terra Nova",
  "isActive": true,
  "lastLoginAt": "2026-10-03T11:20:00.000Z",
  "createdAt": "2026-10-03T11:14:47.000Z",
  "updatedAt": "2026-10-03T11:14:47.000Z",
  "roles": ["citizen"],
  "permissions": ["citizen.home.view", "citizen.services.view"]
}
```

`phone`, `address` et `lastLoginAt` valent `null` quand ils ne sont pas renseignés, et peuvent être absents de la réponse de `/auth/register`. `roles` et `permissions` sont présents sur les routes d'auth, sur `GET /users/:id`, et `roles` seul sur `GET /users`. Ils sont absents des réponses de `PATCH /users/:id/status`. Le mot de passe n'est jamais renvoyé.

### Role

```json
{
  "id": 1, "code": "citizen", "label": "Citoyen", "level": 1, "isSystem": true,
  "permissions": ["citizen.home.view"],
  "usersCount": 42,
  "createdAt": "2026-10-03T11:09:13.000Z", "updatedAt": "2026-10-03T11:09:13.000Z"
}
```

`permissions` est présent sur la liste, le détail et la création. `usersCount` n'est présent que sur le détail (`GET /roles/:id`) et la création.

### Permission

```json
{
  "id": 4, "code": "citizen.services.view", "label": "Consulter les services municipaux",
  "module": "citizen", "roles": ["citizen", "agent", "admin"],
  "createdAt": "2026-10-03T11:09:13.000Z"
}
```

`roles` n'est présent que sur `GET /permissions/:id` et sur la création.

### MunicipalService

```json
{
  "id": 1, "code": "eau_energie", "name": "Eau et énergie", "description": "Distribution et pannes",
  "icon": "droplet", "isActive": true, "sortOrder": 2,
  "createdAt": "2026-10-03T12:33:05.000Z", "updatedAt": "2026-10-03T12:33:05.000Z"
}
```

`description` et `icon` valent `null` quand ils ne sont pas renseignés. `icon` est une chaîne libre (nom d'icône ou URL) que le front interprète.

### Announcement

```json
{
  "id": 6, "title": "Coupure d'eau secteur B", "content": "Texte de l'annonce…",
  "status": "published",
  "author": { "id": 12, "firstName": "Agent", "lastName": "Martin" },
  "publishedAt": "2026-10-03T12:33:46.000Z",
  "createdAt": "2026-10-03T12:33:05.000Z", "updatedAt": "2026-10-03T12:33:46.000Z"
}
```

`status` vaut `draft`, `published` ou `archived`. `author` est `null` si le compte de l'auteur a été supprimé. `publishedAt` est `null` pour un brouillon.

### ContactMessage

```json
{
  "id": 1, "subject": "Panne eau secteur B", "message": "Plus d'eau depuis ce matin…",
  "status": "new",
  "sentAt": "2026-10-03T15:36:02.000Z",
  "confirmedAt": "2026-10-03T15:36:02.000Z",
  "sender": { "id": 18, "email": "awa@example.com", "firstName": "Awa", "lastName": "Diallo" }
}
```

`status` vaut `new`, `read` ou `processed`. `confirmedAt` est l'accusé de réception : il est posé dès que le serveur enregistre le message. `sender` n'est présent que dans les vues des agents (`null` si le compte de l'expéditeur a été supprimé) ; l'expéditeur ne le voit pas sur ses propres messages.

### CitizenRequest

Vue **citoyen** (`/requests/mine`) :

```json
{
  "id": 4, "subject": "Panne d'eau secteur B", "description": "Plus d'eau depuis ce matin",
  "status": "pending",
  "service": { "id": 3, "code": "eau_energie", "name": "Eau et énergie" },
  "createdAt": "2026-10-03T19:14:25.000Z", "updatedAt": "2026-10-03T19:14:25.000Z"
}
```

Vue **agent** (`/requests`) : les mêmes champs, plus `priority` (`low`, `medium`, `high` ou `urgent`), `userId`, `assignedTo`, `owner` (`{ id, firstName, lastName }`) et `assignee`. La priorité est un outil de tri interne : elle n'apparaît **pas** dans la vue citoyen.

`status` vaut `pending`, `in_progress`, `resolved` ou `rejected`. Le détail d'une demande ajoute `history` : `[{ oldStatus, newStatus, note, changedAt, author }]`.

### AuditLog

```json
{ "id": 6, "userId": 3, "action": "user.register", "entityType": "users", "entityId": 3, "ipAddress": "::1", "createdAt": "2026-10-03T11:23:45.000Z" }
```

---

## Endpoints

### Santé

| | |
|---|---|
| `GET /api/health` | Public. Le processus répond : `{ "status": "ok - server is running" }` |
| `GET /api/health/ready` | Public. Le processus **et la base de données** répondent (délai de 2 s). **200** `{ "status": "ready", "database": "up", "responseMs": 1, "uptimeSeconds": 19 }` ou **503** `{ "status": "unavailable", "database": "down" }`. À donner à l'hébergeur ou à un outil de supervision |
| `GET /api/public/services` | Public. Catalogue des services actifs |
| `GET /api/public/announcements?page=&limit=` | Public. Annonces **publiées** uniquement (`{ announcements: [{ id, title, content, publishedAt }], page, limit, total }`), sans auteur ni statut, les plus récentes d'abord |

### Auth — `/api/auth`

#### `POST /api/auth/register` — Créer un compte (public)

Le compte reçoit le rôle choisi (`role`), `citizen` par défaut. `admin` n'est jamais attribuable ici.

```json
{
  "email": "awa@example.com",
  "password": "motdepasse123",
  "firstName": "Awa",
  "lastName": "Diallo",
  "phone": "+2250102030405",
  "address": "12 rue des Dômes"
}
```

| Champ | Règle |
|---|---|
| `email` | Obligatoire, format valide, 255 max, unique (converti en minuscules) |
| `password` | Obligatoire, **8 à 128 caractères** |
| `firstName`, `lastName` | Obligatoires, 100 max |
| `role` | Optionnel : `citizen` (défaut) ou `agent`. L'inscription libre en agent est ouverte, mais ce compte est **non validé** (voir « Sécurité web ») : les coordonnées des citoyens lui sont masquées tant qu'un administrateur ne l'a pas validé. `admin` est toujours refusé (400) |
| `phone` | Optionnel, 30 max |
| `address` | Optionnel, 255 max |

**201** → `{ "user": User, "accessToken": "…", "refreshToken": "…" }`
Erreurs : 400 (champ invalide), 409 (`Cet email est déjà utilisé`).

#### `POST /api/auth/login` — Se connecter (public)

```json
{ "email": "awa@example.com", "password": "motdepasse123" }
```

**200** → `{ "user": User, "accessToken": "…", "refreshToken": "…" }`
Erreurs : 400 (champs manquants), 401 (`Identifiants incorrects`), 403 (`Compte désactivé`).

#### `POST /api/auth/refresh` — Renouveler les tokens (public)

Body vide si le cookie est présent, sinon `{ "refreshToken": "…" }`.

**200** → `{ "user": User, "accessToken": "…", "refreshToken": "…" }` (l'ancien refresh token devient invalide)
Erreurs : 401 (token manquant, invalide, expiré, déjà utilisé, ou compte désactivé).

#### `POST /api/auth/logout` — Fermer la session courante (public)

Body vide (cookie) ou `{ "refreshToken": "…" }`. **204** sans contenu. Supprime le cookie.

#### `POST /api/auth/logout-all` 🔒 — Fermer toutes les sessions

Sans body. **204** sans contenu.

#### `GET /api/auth/me` 🔒 — Profil courant

**200** → `User` (avec `roles` et `permissions`).

#### `GET /api/auth/me/security` 🔒 — Sécurité de mon compte

Ce que l'utilisateur peut vérifier lui-même : où il est connecté, ce qui s'est passé sur son compte, et **qui, parmi le personnel, a consulté ses données**.

```json
{
  "sessions": [
    { "id": 41, "device": "Chrome sur Windows", "ip": "203.0.113.x", "createdAt": "2026-10-04T08:00:00.000Z",
      "lastUsedAt": "2026-10-04T09:12:00.000Z", "expiresAt": "2026-10-14T08:00:00.000Z", "current": true }
  ],
  "events": [
    { "action": "login.failed", "at": "2026-10-04T07:55:00.000Z", "ip": "198.51.100.x" },
    { "action": "login", "at": "2026-10-04T08:00:00.000Z", "ip": "203.0.113.x" }
  ],
  "dataAccess": [
    { "at": "2026-10-04T09:30:00.000Z", "by": "Marie D.", "role": "agent", "resource": "request" }
  ]
}
```

- `sessions` : les sessions ouvertes (une par appareil). `current` désigne celle de l'appel. `ip` est masquée (dernier octet).
- `events` (30 derniers) : `user.register`, `login`, **`login.failed`** (quelqu'un a essayé un mauvais mot de passe sur ce compte), `login.blocked`, `password.change`, `profile.update`, `logout.all`, `session.revoke`.
- `dataAccess` (20 derniers) : consultations d'une de **mes** demandes, d'un de mes messages ou de mon compte par un autre utilisateur. `by` : prénom et initiale ; `role` : `agent` ou `admin` ; `resource` : `request`, `message` ou `account`. Ni e-mail ni adresse IP de la personne ne sont exposés. Lu dans le journal d'audit : il suppose `AUDIT_REQUESTS=all` (défaut) et n'inclut que les consultations d'un dossier précis, pas les listes.

#### `DELETE /api/auth/me/sessions/:id` 🔒 — Fermer une de mes sessions

Appareil perdu, connexion inconnue. **204**. **404** si la session n'existe pas **ou n'est pas à moi** (on ne peut pas savoir qu'elle existe). Audité (`session.revoke`).

#### `GET /api/auth/me/welcome` 🔒 — Faut-il afficher l'accueil ?

Sert à la modale de bienvenue du dashboard : le serveur compte les **sessions ouvertes** de l'utilisateur (lignes non expirées de `auth_tokens`, une par session) et propose l'accueil tant qu'il y en a **moins de 2**.

**200** → `{ "showWelcome": true, "sessionCount": 1 }`

| Situation | `sessionCount` | `showWelcome` |
|---|:-:|:-:|
| Juste après l'inscription | 1 | `true` |
| Une 2e connexion (autre appareil, autre navigateur) | 2 | `false` |
| Après un refresh de token (rotation) | inchangé | inchangé |
| Après une déconnexion d'une des deux sessions | 1 | `true` |

Le compte revient à 1 session dès qu'on se déconnecte, donc `showWelcome` redevient `true` à la connexion suivante : le front mémorise aussi localement que la modale a été vue pour ne pas la remontrer.

#### `PATCH /api/auth/me` 🔒 — Modifier son profil

Tous les champs sont optionnels, mais il en faut au moins un.

```json
{ "firstName": "Awa", "lastName": "Diallo", "email": "nouveau@example.com", "phone": "+225...", "address": "…" }
```

- `firstName`, `lastName` : ne peuvent pas être vides.
- `phone`, `address` : `null` ou `""` pour les effacer.
- `email` : doit rester unique.

**200** → `User`. Erreurs : 400, 409 (email pris).

#### `PATCH /api/auth/me/password` 🔒 — Changer son mot de passe

```json
{ "currentPassword": "ancien", "newPassword": "nouveau-motdepasse" }
```

Toutes les autres sessions sont déconnectées ; la session courante reçoit de nouveaux tokens.
**200** → `{ "user": User, "accessToken": "…", "refreshToken": "…" }`. Erreurs : 400, 401 (`Mot de passe actuel incorrect`).

---

### Utilisateurs — `/api/users` 🛡️

#### `GET /api/users?q=&page=&limit=` — Lister

`q` filtre sur l'email, le prénom et le nom.

**200** → `{ "users": [User avec roles], "page": 1, "limit": 20, "total": 57 }`

#### `GET /api/users/:id` — Détail

**200** → `User` (avec `roles` et `permissions`). Erreurs : 400, 404.

#### `PATCH /api/users/:id/status` — Activer / désactiver

```json
{ "isActive": false }
```

Désactiver ferme aussi toutes les sessions de l'utilisateur, et son access token est refusé immédiatement.
**200** → `User`. Erreurs : 400 (dont `Vous ne pouvez pas désactiver votre propre compte`), 404.

#### `POST /api/users/:id/roles` — Attribuer un rôle

```json
{ "role": "agent" }
```

**201** (rôle ajouté) ou **200** (déjà possédé) → `{ "roles": ["agent", "citizen"] }`. Erreurs : 400 (rôle inconnu), 404.

#### `GET /api/users/pending-agents` — Agents en attente de validation

Les agents qui se sont inscrits seuls et n'ont pas encore été validés : **200** → `{ "users": [{ "id", "email", "firstName", "lastName", "createdAt" }] }`.

#### `POST /api/users/:id/validate-agent` — Valider un agent

Confirme qu'un agent inscrit seul est de confiance : il voit alors les coordonnées complètes des citoyens, peut modifier leurs comptes, et sa limite de consultation passe de 30 à 150 par minute. **200** `{ "validated": true }` (ou `false` s'il l'était déjà). **404** si l'utilisateur n'est pas agent. Effet immédiat. Audité (`agent.validate`). Attribuer le rôle `agent` à un compte qui l'a déjà (`POST /users/:id/roles`) le valide aussi.

#### `DELETE /api/users/:id/roles/:code` — Retirer un rôle

**200** → `{ "roles": ["citizen"] }`. Erreurs : 400 (`Impossible de retirer le dernier administrateur`), 404 (rôle inconnu ou non possédé).

---

### Rôles — `/api/roles` 🛡️

#### `GET /api/roles` — Lister
**200** → `[Role avec permissions]`, triés par niveau.

#### `GET /api/roles/:id` — Détail
**200** → `Role` (avec `permissions` et `usersCount`). Erreurs : 400, 404.

#### `POST /api/roles` — Créer

```json
{ "code": "moderator", "label": "Modérateur", "level": 2 }
```

| Champ | Règle |
|---|---|
| `code` | Obligatoire, `^[a-z][a-z0-9_]{1,49}$`, unique |
| `label` | Obligatoire, 100 max |
| `level` | Optionnel, entier de 0 à 1000 (0 par défaut) |

**201** → `Role` (`isSystem` toujours `false`). Erreurs : 400, 409.

#### `PATCH /api/roles/:id` — Modifier
`{ "label": "…", "level": 3 }` (au moins un champ ; le `code` est immuable). **200** → `Role`.

#### `DELETE /api/roles/:id` — Supprimer
**204**. Erreurs : 403 (rôle système), 409 (encore attribué à des utilisateurs), 404.

#### Permissions d'un rôle

| Route | Body | Réponse |
|---|---|---|
| `GET /api/roles/:id/permissions` | — | `{ "role": Role, "permissions": [Permission] }` |
| `POST /api/roles/:id/permissions` | `{ "permissions": ["a.b.c", …] }` ou `{ "permission": "a.b.c" }` | **201** si ajout, **200** sinon : `{ "added": 1, "permissions": [Permission] }` |
| `PUT /api/roles/:id/permissions` | `{ "permissions": ["a.b.c", …] }` (remplace tout ; `[]` retire tout) | `{ "permissions": [Permission] }` |
| `DELETE /api/roles/:id/permissions/:code` | — | `{ "permissions": [Permission] }` |

Les permissions sont désignées par leur **code**. Un code inconnu renvoie 400 avec la liste des codes inconnus. Le rôle `admin` ne peut pas perdre `admin.users.manage` (400). Le changement s'applique immédiatement à tous les utilisateurs du rôle.

---

### Permissions — `/api/permissions` 🛡️

#### `GET /api/permissions?module=&grouped=true` — Lister
**200** → `[Permission]`. Avec `grouped=true` : `{ "citizen": [Permission, …], "agent": […], "admin": […] }`.

#### `GET /api/permissions/:id` — Détail
**200** → `Permission` avec `roles`. Erreurs : 400, 404.

#### `POST /api/permissions` — Créer

```json
{ "code": "citizen.reports.create", "label": "Signaler un problème", "module": "citizen" }
```

| Champ | Règle |
|---|---|
| `code` | Obligatoire, format `module.ressource.action` en minuscules, 100 max, unique |
| `label` | Obligatoire, 150 max |
| `module` | Optionnel : déduit du premier segment du code |

**201** → `Permission`. Erreurs : 400, 409.

#### `PATCH /api/permissions/:id` — Modifier
`{ "label": "…", "module": "…" }` (au moins un champ ; le `code` est immuable). **200** → `Permission`.

#### `DELETE /api/permissions/:id` — Supprimer
**204**. Si la permission est attribuée à des rôles : **409** `{ "message": "…", "roles": ["citizen"] }`. Avec `?force=true`, elle est d'abord détachée de ces rôles puis supprimée.

---

### Services municipaux — `/api/services`

Lecture : permission `citizen.services.view` (tout citoyen connecté). Gestion : permission `admin.services.manage` (administrateur).
Les services sont triés par `sortOrder` puis par `name`.

#### `GET /api/services?all=true` 🔒 — Lister

Renvoie les services **actifs**. Les gestionnaires peuvent ajouter `?all=true` pour inclure les services désactivés ; ce paramètre est ignoré pour les autres.

**200** → `[MunicipalService]`

#### `GET /api/services/:id` 🔒 — Détail

**200** → `MunicipalService` + **`related`** : les 3 cartes « Autres services » à afficher sous le détail. Erreurs : 400, 404 (un service désactivé est introuvable pour un non-gestionnaire).

```json
{
  "id": 1, "code": "etat_civil", "name": "État civil et identité", "...": "...",
  "related": [
    { "id": 4, "code": "sante", "name": "Santé et secours", "description": "…", "icon": "heart-pulse", "reviewsCount": 3, "averageRating": 4.3, "reviewedByMe": false, "reason": "often_together" },
    { "id": 3, "code": "transport", "name": "Transports et mobilité", "...": "...", "reason": "popular" },
    { "id": 2, "code": "eau_energie", "name": "Eau et énergie", "...": "...", "reason": "catalog" }
  ]
}
```

Choix des 3 services, jamais le service lui-même ni un service désactivé : d'abord ceux que **les mêmes habitants ont aussi sollicités** (`reason: "often_together"`), puis les plus demandés (`popular`), puis l'ordre du catalogue (`catalog`). Toujours 3 dès que le catalogue compte au moins 4 services actifs. Calcul gardé 30 s en cache. Chaque carte a les mêmes champs qu'un `MunicipalService` (nom, icône, description, note moyenne). Vérification : `node tools/services-related-check.mjs 5000`.

#### `POST /api/services` 🔒 (`admin.services.manage`) — Créer

```json
{ "code": "eau_energie", "name": "Eau et énergie", "description": "…", "icon": "droplet", "isActive": true, "sortOrder": 2 }
```

| Champ | Règle |
|---|---|
| `code` | Obligatoire, `^[a-z][a-z0-9_-]{1,49}$`, unique |
| `name` | Obligatoire, 150 max |
| `description` | Optionnel, texte (65 000 max) |
| `icon` | Optionnel, 255 max |
| `isActive` | Optionnel, booléen (`true` par défaut) |
| `sortOrder` | Optionnel, entier (`0` par défaut) |

**201** → `MunicipalService`. Erreurs : 400, 403, 409 (code déjà pris).

#### `PATCH /api/services/:id` 🔒 (`admin.services.manage`) — Modifier

Champs optionnels (au moins un) : `name`, `description`, `icon`, `isActive`, `sortOrder`. `description` et `icon` à `null` ou `""` les effacent. Le `code` est immuable.
**200** → `MunicipalService`. Erreurs : 400, 403, 404.

#### `DELETE /api/services/:id` 🔒 (`admin.services.manage`) — Supprimer

**204**. Erreurs : 403, 404. Pour masquer un service sans le perdre, préférez `PATCH` avec `{ "isActive": false }`.

#### Avis sur les services

Un citoyen dont une demande a été **traitée** (statut `resolved`) sur un service peut le noter (1 à 5 étoiles) et laisser un commentaire. **Un seul avis par citoyen et par service.** Table `service_reviews` (créée par `npm run db:sync`).

`GET /api/services` et `GET /api/services/:id` renvoient en plus `reviewsCount`, `averageRating` (1 décimale, `null` sans avis) et `reviewedByMe` (l'utilisateur connecté a déjà donné son avis).

| Route | Permission | Réponse |
|---|---|---|
| `GET /api/services/:id/reviews?page=&limit=` | `citizen.services.view` | `{ "reviews": [{ id, serviceId, rating, comment, authorName, createdAt }], "reviewsCount", "averageRating", "page", "limit", "total" }` (`authorName` : prénom et initiale du nom) |
| `GET /api/services/reviews/mine` | `citizen.services.view` | `[{ id, serviceId, rating, comment, createdAt }]` : avis du citoyen connecté |
| `POST /api/services/:id/reviews` | `citizen.requests.create` | **201** → `{ id, serviceId, rating, comment, createdAt }` |

`POST` : `{ "rating": 4, "comment": "Traitement rapide" }` (`rating` entier de 1 à 5 ; `comment` de 3 à 2 000 caractères). Erreurs : 400, 403 (aucune demande traitée sur ce service), 404, 409 (avis déjà donné). Action d'audit : `review.create`.

---

### Annonces — `/api/announcements`

Lecture : permission `citizen.announcements.view` (tout citoyen connecté). Gestion : permission `agent.announcements.manage` (agent et administrateur).
Un citoyen ne voit que les annonces **publiées** ; brouillons et archives lui sont invisibles (404 sur le détail).

#### `GET /api/announcements?q=&status=&page=&limit=` 🔒 — Lister

| Paramètre | Rôle |
|---|---|
| `q` | Recherche dans le titre et le contenu |
| `status` | Réservé aux gestionnaires : `draft`, `published`, `archived` ou `all` (ignoré pour les autres) ; `published` par défaut |
| `page`, `limit` | Pagination |

Tri : les plus récemment publiées d'abord (les brouillons sont triés par date de création).

**200** → `{ "announcements": [Announcement], "page": 1, "limit": 20, "total": 12 }`. Erreur : 400 (`status` invalide).

#### `GET /api/announcements/:id` 🔒 — Détail

**200** → `Announcement`. Erreurs : 400, 404.

#### `POST /api/announcements` 🔒 (`agent.announcements.manage`) — Créer

```json
{ "title": "Coupure d'eau secteur B", "content": "Texte de l'annonce…", "status": "draft" }
```

| Champ | Règle |
|---|---|
| `title` | Obligatoire, 255 max |
| `content` | Obligatoire, 65 000 max |
| `status` | Optionnel : `draft` (par défaut), `published` ou `archived` |

L'auteur est l'utilisateur connecté. Avec `status: "published"`, `publishedAt` vaut l'instant de création.
**201** → `Announcement`. Erreurs : 400, 403.

#### `PATCH /api/announcements/:id` 🔒 (`agent.announcements.manage`) — Modifier / changer de statut

Champs optionnels (au moins un) : `title`, `content`, `status`. **200** → `Announcement`. Erreurs : 400, 403, 404.

Effet du changement de `status` sur `publishedAt` :

| Passage à | `publishedAt` |
|---|---|
| `published` | Date du jour s'il n'a jamais été publié, sinon la date d'origine est conservée |
| `archived` | Conservé |
| `draft` | Effacé (`null`) |

#### `DELETE /api/announcements/:id` 🔒 (`agent.announcements.manage`) — Supprimer

**204**. Erreurs : 403, 404. Pour retirer une annonce de la vue publique en gardant l'historique, passez-la en `archived`.

---

### Messages de contact — `/api/contact-messages`

Un citoyen écrit aux services municipaux et suit ses messages. Les agents traitent la boîte de réception.
Envoi et consultation : permission `citizen.message.send`. Traitement : permission `agent.messages.manage` (agent et administrateur).

#### `POST /api/contact-messages` 🔒 (`citizen.message.send`) — Envoyer un message

```json
{ "subject": "Panne eau secteur B", "message": "Plus d'eau depuis ce matin au secteur B" }
```

| Champ | Règle |
|---|---|
| `subject` | Obligatoire, 3 à 255 caractères |
| `message` | Obligatoire, 10 à 3 000 caractères |

**201** → `{ "confirmation": "Votre message a bien été reçu. Référence : #1", "contactMessage": ContactMessage }` (statut `new`, `confirmedAt` renseigné).
Erreurs : 400, 401, 403.

#### `GET /api/contact-messages/mine` 🔒 (`citizen.message.send`) — Mes messages

**200** → `[ContactMessage]` (sans `sender`), du plus récent au plus ancien.

#### `GET /api/contact-messages/:id` 🔒 (`citizen.message.send`) — Détail

Un agent voit n'importe quel message (avec `sender`) ; un citoyen uniquement les siens (sans `sender`).
**200** → `ContactMessage`. Erreurs : 400, 404 (message inexistant **ou** appartenant à un autre citoyen).

#### `GET /api/contact-messages?status=&q=&page=&limit=` 🔒 (`agent.messages.manage`) — Boîte de réception

| Paramètre | Rôle |
|---|---|
| `status` | `new`, `read`, `processed` ou `all` (défaut : tous) |
| `q` | Recherche dans le sujet et le message |
| `page`, `limit` | Pagination |

Tri : les `new` d'abord, puis `read`, puis `processed`, et par date décroissante dans chaque groupe.

**200** → `{ "messages": [ContactMessage avec sender], "counts": { "new": 3, "read": 1, "processed": 8 }, "page": 1, "limit": 20, "total": 12 }`
`counts` donne le total par statut sur **tous** les messages, quel que soit le filtre : pratique pour un badge « 3 nouveaux ». Erreurs : 400 (`status` invalide), 403.

#### `PATCH /api/contact-messages/:id/status` 🔒 (`agent.messages.manage`) — Changer le statut

```json
{ "status": "processed" }
```

Tous les passages sont permis (`new`, `read`, `processed`) et le changement est idempotent.
**200** → `ContactMessage` (avec `sender`). Erreurs : 400, 403, 404.

---

### Demandes citoyennes — `/api/requests`

Un citoyen dépose une demande à la ville et suit son traitement ; les agents la traitent. Chaque changement de statut ou d'assignation écrit une ligne dans l'historique.

| Route | Permission |
|---|---|
| `POST /api/requests` | `citizen.requests.create` |
| `GET /api/requests/mine`, `GET /api/requests/mine/:id` | `citizen.requests.view` |
| `GET /api/requests`, `GET /api/requests/:id` | `agent.requests.view` |
| `PATCH /api/requests/:id` | `agent.requests.manage` |

#### `POST /api/requests` 🔒 — Déposer une demande

```json
{ "subject": "Panne d'eau secteur B", "description": "Plus d'eau depuis ce matin", "serviceId": 3 }
```

`subject` obligatoire (255 max) ; `description` (5 000 max) et `serviceId` optionnels. La demande est créée au statut `pending` avec la priorité `medium` : **le citoyen ne peut pas choisir la priorité** (un champ `priority` envoyé ici est ignoré).
**201** → `CitizenRequest` (vue citoyen). Erreurs : 400 (objet manquant, service inconnu), 403.

#### `GET /api/requests/mine?status=` 🔒 — Mes demandes

`status` : `pending`, `in_progress`, `resolved`, `rejected`, une liste séparée par des virgules, ou `all`.
**200** → `{ "requests": [CitizenRequest], "limit": 20, "offset": 0, "total": 3 }`. Un citoyen ne voit que ses propres demandes.

#### `GET /api/requests/mine/:id` 🔒 — Suivre une demande

**200** → `CitizenRequest` + `history`. Erreurs : 400, 404 (inexistante **ou** appartenant à un autre citoyen).

#### `GET /api/requests?status=&priority=&sort=&assignedTo=&mine=` 🔒 (`agent.requests.view`) — File des agents

| Paramètre | Rôle |
|---|---|
| `status` | Comme ci-dessus |
| `priority` | `low`, `medium`, `high`, `urgent`, une liste (`urgent,high`) ou `all` |
| `sort` | `priority` : les plus urgentes d'abord, puis les plus anciennes dans chaque niveau. Sans ce paramètre : les plus récentes d'abord |
| `assignedTo` | Id d'un agent |
| `mine` | `true` : seulement les demandes assignées à l'agent connecté |

**200** → `{ "requests": [vue agent], "limit": 20, "offset": 0, "total": 12 }`. Erreurs : 400 (paramètre invalide), 403.

#### `GET /api/requests/:id` 🔒 (`agent.requests.view`) — Détail agent

**200** → vue agent + `history`. Erreurs : 400, 404.

#### `PATCH /api/requests/:id` 🔒 (`agent.requests.manage`) — Traiter, assigner, classer

```json
{ "status": "in_progress", "assignedTo": 7, "priority": "urgent", "note": "Équipe envoyée" }
```

Tous les champs sont optionnels, mais il en faut au moins un parmi `status`, `assignedTo` et `priority`.

| Champ | Règle |
|---|---|
| `status` | Transitions permises : `pending` → `in_progress` ou `rejected` ; `in_progress` → `resolved` ou `rejected` ; `rejected` → `pending` ; `resolved` est final. Autre passage : **409**. Clôturer (`resolved`, `rejected`) exige une `note` (400) |
| `assignedTo` | Id d'un agent, ou `null` pour retirer l'assignation |
| `priority` | `low`, `medium`, `high` ou `urgent`. Modifier la priorité seule n'est **pas** un changement d'état : pas de ligne dans l'historique des statuts (la trace est dans le journal d'audit : `request.priority`) |
| `note` | Motif, 2 000 max, enregistré dans l'historique |

Quand plusieurs champs sont envoyés ensemble, ils sont appliqués dans **une seule transaction** : si le statut est refusé (409), la priorité n'est pas modifiée non plus.
**200** → vue agent + `history`. Erreurs : 400 (valeur invalide, rien à modifier, déjà dans cet état), 403, 404, 409.

---

### Signalements (urgences et incidents) — `/api/signalements`

Une personne signale une urgence médicale, un incendie, une inondation, une panne... Ce n'est **pas** une demande ordinaire : elle se traite en minutes. Ce qui change par rapport à `/api/requests` :

- **La priorité vient du type**, jamais de la requête : médical et incendie sont urgents d'office ; le déclarant ne peut pas la baisser, seulement l'**élever** (`lifeThreatening: true`, « une personne est en danger immédiat »). Le personnel peut ensuite l'ajuster.
- **L'envoi n'est jamais freiné** : pas de jeton anti-robots, pas de délai minimal de remplissage. Le compte est authentifié, plafonné (20 envois par 10 min) et chaque envoi est tracé.
- **Un délai de prise en compte est visé** selon la priorité ; au-delà, le signalement est « en retard » et remonte en tête.
- **La liste du personnel est triée par attention**, pas par date, avec des compteurs et une **alerte temps réel**.

Tables : `signalements` et `signalement_history` (créées par `npm run db:sync`). Vérification de bout en bout : `node tools/signalement-check.mjs 5000` (API locale lancée) ; il crée puis supprime ses données de test.

| Type (`type`) | Libellé | Priorité automatique | Urgence vitale |
|---|---|:-:|:-:|
| `medical` | Urgence médicale | `urgent` | oui |
| `fire` | Incendie | `urgent` | oui |
| `flood` | Inondation | `high` | |
| `cyclone` | Cyclone | `high` | |
| `accident` | Accident | `high` | |
| `security` | Sécurité | `high` | |
| `breakdown` | Panne | `medium` | |
| `heavy_rain` | Forte pluie | `medium` | |
| `other` | Autre signalement | `low` | |

| Priorité | Délai visé pour la prise en compte |
|---|:-:|
| `urgent` | 5 min |
| `high` | 30 min |
| `medium` | 4 h |
| `low` | 24 h |

Statuts : `new` (reçu) → `acknowledged` (pris en compte) → `in_progress` → `resolved`, ou `cancelled` (fausse alerte, erreur ; motif obligatoire pour le personnel).

**Ordre « attention »** (défaut de la liste du personnel) : 1) urgent non pris en compte ; 2) **en retard** sur son délai ; 3) important non pris en compte ; 4) urgent ou important déjà pris en charge, à suivre ; 5) le reste non pris en compte ; 6) le reste en cours ; 7) clos. À rang égal, la priorité puis le plus ancien.

#### Objet `Signalement`

Vue du **déclarant** :

```json
{
  "id": 12, "type": "medical", "label": { "fr": "Urgence médicale", "en": "Medical emergency" },
  "priority": "urgent", "status": "acknowledged", "title": "Urgence médicale",
  "description": "Personne âgée inconsciente", "location": "Dôme 3, secteur B", "contactPhone": "+225 01 02 03 04",
  "createdAt": "2026-10-04T03:11:12.000Z", "acknowledged": true, "acknowledgedAt": "2026-10-04T03:12:40.000Z",
  "resolvedAt": null, "handledBy": "Marie S."
}
```

Vue du **personnel** : les mêmes champs, plus `emergency`, `reporter` (`{ id, firstName, lastName }`), `assignedTo`, `assignee`, `ageMinutes`, `slaMinutes` et `overdue`. Les notes internes et l'historique complet ne sont visibles que du personnel ; le déclarant voit un déroulé des états, sans notes et sans identité complète de l'agent.

#### Déclarant

| Route | Permission | Rôle |
|---|---|---|
| `GET /api/signalements/types` | `citizen.signalements.create` | Les 9 types avec `label`, `defaultPriority`, `emergency` |
| `POST /api/signalements` | `citizen.signalements.create` | Signaler |
| `GET /api/signalements/mine?status=open\|closed\|all` | `citizen.signalements.view` | Mes signalements, les ouverts d'abord |
| `GET /api/signalements/mine/:id` | `citizen.signalements.view` | Détail et `timeline` (états successifs). 404 si ce n'est pas le mien |
| `POST /api/signalements/mine/:id/cancel` | `citizen.signalements.view` | Annuler une alerte envoyée par erreur, tant qu'elle est `new` ou `acknowledged` (sinon 409) |

`POST /api/signalements` :

```json
{ "type": "medical", "location": "Dôme 3, secteur B, place centrale", "description": "Personne inconsciente", "contactPhone": "+225 01 02 03 04", "lifeThreatening": true }
```

| Champ | Règle |
|---|---|
| `type` | Obligatoire, voir le tableau |
| `location` | Obligatoire, 2 à 255 caractères |
| `title` | Optionnel (3 à 200) ; par défaut, le libellé du type dans la langue du déclarant |
| `description` | Optionnel, 5 000 max |
| `contactPhone` | Optionnel, numéro de rappel (chiffres, `+`, espaces, `.-()`, 5 à 30) |
| `lifeThreatening` | Optionnel : `true` rend le signalement urgent quel que soit son type |
| `clientRef` | Optionnel : identifiant choisi par l'appareil (8 à 64 caractères `A-Z a-z 0-9 - _`) pour un signalement préparé **hors ligne**. Un renvoi avec le même `clientRef` rend le signalement existant (`200`, `duplicate: true`) au lieu d'en créer un second |
| `reportedAt` | Optionnel : heure réelle du constat (ISO, 24 h au plus dans le passé) quand l'envoi a été retardé par une panne. Rendue dans la réponse |
| `zone` | Optionnel : quartier (`north`, `south`, `east`, `west`, `center`) ; sert au repérage des points chauds et aux consignes rendues (400 si inconnu) |
| `priority` | **Ignoré** : la priorité ne se choisit pas |

**201** → `Signalement` + `{ "duplicate": false, "urgent": true, "acknowledgeTargetMinutes": 5, "guidance": "Votre alerte a été transmise aux équipes d'intervention. Si une vie est en danger immédiat, contactez aussi les secours (112)." }`. Le numéro vient de `EMERGENCY_NUMBER`.
La réponse contient aussi **`activeAlerts`** : les alertes à la population en cours pour ce quartier (toutes si `zone` est absente), au format public décrit dans « Alertes à la population ». Une personne qui signale une inondation au sud voit ainsi aussitôt les consignes déjà en vigueur.
**200** avec `"duplicate": true` : le même compte vient d'envoyer le même type au même lieu (moins de 3 min, encore `new`) ; c'est ce signalement qui est rendu, pas une seconde alerte (double-clic, réseau instable).
Erreurs : 400 (champ invalide), 401, 403, **429** `RATE_LIMITED` au-delà de 20 envois en 10 minutes par compte (`SIGNALEMENT_RATE_LIMIT_PER_10MIN`).

#### Personnel

| Route | Permission | Rôle |
|---|---|---|
| `GET /api/signalements/summary` | `agent.signalements.view` | Compteurs pour pastilles et bandeau d'alerte |
| `GET /api/signalements` | `agent.signalements.view` | File, triée par attention |
| `GET /api/signalements/:id` | `agent.signalements.view` | Détail + `history` complet (auteur, notes) |
| `POST /api/signalements/:id/acknowledge` | `agent.signalements.manage` | « Je m'en occupe » : `acknowledged`, assigné à soi s'il ne l'était pas. **409** `already_acknowledged` si un autre agent l'a déjà pris |
| `PATCH /api/signalements/:id` | `agent.signalements.manage` | `{ status?, priority?, assignedTo?, note? }` ; `assignedTo` doit être un membre du personnel ; `cancelled` exige une `note` |

`GET /api/signalements/summary` → `{ "open": 5, "unacknowledged": 3, "urgentOpen": 2, "overdue": 1, "unassigned": 4, "mine": 1, "oldestUnacknowledgedMinutes": 300, "byPriority": { "urgent": 2, "medium": 1 }, "byType": { "medical": 1, "fire": 1 }, "byZone": { "south": 3 }, "hotspots": [{ "zone": "south", "type": "flood", "count": 2, "latestAt": "2026-10-04T03:30:53.000Z", "alertActive": true }], "activeAlerts": 1 }`

**`hotspots`** (points chauds) : au moins 2 signalements ouverts d'inondation, forte pluie, cyclone ou incendie dans le **même quartier** en moins de 3 h. `alertActive: false` signifie qu'aucune alerte de ce danger ne couvre ce quartier : le personnel doit sans doute prévenir la population (`POST /api/alerts`). `activeAlerts` : nombre d'alertes à la population en cours.

`GET /api/signalements` :

| Paramètre | Rôle |
|---|---|
| `status` | `open` (défaut), `closed`, `all`, ou une liste (`new,in_progress`) |
| `priority`, `type` | Une valeur ou une liste |
| `assigned` | `me`, `none` (personne), ou l'id d'un agent |
| `zone` | Un quartier (`north`, `south`, `east`, `west`, `center`) |
| `overdue` | `true` : seulement les signalements en retard |
| `q` | Recherche dans le titre et le lieu. **Jamais dans la description**, qui peut contenir des données de santé |
| `sort` | `attention` (défaut), `recent`, `oldest` |
| `page`, `limit` | Pagination |

**200** → `{ "signalements": [Signalement du personnel], "page": 1, "limit": 20, "total": 5 }`. Ces lectures comptent dans le plafond de consultation du personnel (voir « Sécurité web »).

#### Alerte temps réel (personnel)

Espace de noms socket.io **`/staff`**, à la racine du serveur de l'API (comme le canal des annonces). Connexion avec le jeton d'accès : `io(API_ORIGIN + "/staff", { auth: { token: accessToken } })`. Refusée sans jeton (`unauthorized`) ou sans la permission `agent.signalements.view` (`forbidden`) ; au plus 4 connexions par compte ; la connexion est coupée à l'expiration du jeton, à rouvrir avec un jeton rafraîchi.

| Événement | Quand | Contenu |
|---|---|---|
| `signalement:new` | Nouveau signalement `urgent` ou `high` | `{ id, type, priority, status, title, location, createdAt, assignedTo }` |
| `signalement:updated` | Prise en compte, changement d'état, de priorité ou d'assignation, annulation | Idem |

Ni description, ni téléphone, ni identité du déclarant ne transitent par ce canal : le détail s'ouvre par l'API, qui vérifie les droits et trace l'accès.

#### Protection des données

- Le déclarant voit, dans `GET /api/auth/me/security` (`dataAccess`, `resource: "report"`), quel membre du personnel a consulté son signalement.
- Un agent **non validé** (inscription libre) ne voit le téléphone de rappel que pour un signalement **urgent** : joindre une personne en détresse ne doit jamais être retardé. Il peut prendre en charge et traiter un signalement : le travail d'urgence n'est pas bloqué.
- Si le compte du déclarant est supprimé, le signalement est conservé (`user_id` passe à `NULL`) : une urgence reste tracée.

Actions d'audit : `signalement.create`, `signalement.acknowledge`, `signalement.status`, `signalement.priority`, `signalement.assigned`, `signalement.update` (plusieurs changements à la fois), `signalement.cancel`, `rate.limited` (`entityType: "signalements"`).

**Pas encore fait** : le déclarant n'est pas notifié par une notification quand son signalement est pris en compte (il voit l'état en ouvrant le signalement) ; pas de regroupement des signalements identiques venant de plusieurs personnes (une même inondation signalée vingt fois) ; pas de coordonnées GPS.

---

### Alertes à la population — `/api/public/alerts` (public) et `/api/alerts` (personnel)

Scénario : *une montée inhabituelle du niveau de l'eau est observée dans le quartier sud ; les habitants doivent être informés rapidement, au bon moment, et comprendre immédiatement ce qu'ils doivent savoir ou faire.*

- **Les bonnes personnes** : une alerte vise un ou plusieurs quartiers (ou toute la ville). Le client ne l'affiche qu'aux habitants concernés (quartier choisi, mémorisé côté client).
- **Tout de suite** : la publication est poussée en temps réel sur le canal public socket.io, **sans compte** ; les lectures publiques ne sont jamais servies périmées (cache serveur 5 s, `Cache-Control: no-cache`).
- **Compréhensible d'un coup d'œil** : une phrase-titre prête pour un bandeau, une couleur de gravité, `actionRequired`, et des **consignes courtes** (« que faire ? »), obligatoires dès le niveau « alerte ».
- **Au bon moment** : la plus grave d'abord ; l'alerte expire seule (`expiresAt`) ; une **fin d'alerte** explicite dit quand la situation est revenue à la normale (affichée 6 h).
- **Qui peut alerter** : permission `agent.alerts.manage`, et **agent validé** uniquement (403 `agent_not_validated` pour une inscription libre). Toute publication est tracée.

Tables : `alerts` et `alert_updates` (`npm run db:sync`). Vérification de bout en bout sur ce scénario : `node tools/alert-check.mjs 5000` (API locale lancée ; crée puis supprime ses données de test).

| Quartier (`zone`) | Libellé |
|---|---|
| `north` | Quartier nord |
| `south` | Quartier sud |
| `east` | Quartier est |
| `west` | Quartier ouest |
| `center` | Centre-ville |
| `all` | Toute la ville (alerte uniquement, seul dans la liste) |

| Gravité (`severity`) | Libellé | Couleur | Action requise | Consignes | Durée par défaut |
|---|---|:-:|:-:|:-:|:-:|
| `info` | Information | `blue` | | optionnelles | 24 h |
| `watch` | Vigilance | `yellow` | | optionnelles | 24 h |
| `warning` | Alerte : protégez-vous | `orange` | oui | **obligatoires** | 12 h |
| `emergency` | Urgence : agissez maintenant | `red` | oui | **obligatoires** | 6 h |

Dangers (`hazard`) : `flood` (montée des eaux / inondation), `heavy_rain`, `cyclone`, `fire`, `power_outage`, `water_outage`, `security`, `health`, `transport` (transports perturbés, créée automatiquement, voir « Transports »), `network` (panne de réseau / communications), `other`.

#### Objet `Alert` (public)

```json
{
  "id": 7, "status": "active", "severity": "warning",
  "severityLabel": { "fr": "Alerte : protégez-vous", "en": "Warning: protect yourself" },
  "color": "orange", "actionRequired": true,
  "hazard": "flood", "hazardLabel": { "fr": "Montée des eaux / inondation", "en": "Rising water / flood" },
  "zones": ["south"], "zoneLabels": { "fr": ["Quartier sud"], "en": ["South district"] },
  "headline": { "fr": "ALERTE : PROTÉGEZ-VOUS — Montée inhabituelle de l'eau · Quartier sud", "en": "..." },
  "title": "Montée inhabituelle de l'eau",
  "message": "Le niveau de l'eau monte anormalement le long du canal sud...",
  "instructions": ["Montez à l'étage ou en hauteur", "Évitez les rues basses et le bord du canal", "Ne traversez jamais une zone inondée"],
  "endMessage": null,
  "issuer": { "fr": "Services municipaux de Terra Nova", "en": "..." },
  "startsAt": "2026-10-04T03:30:52.000Z", "expiresAt": "2026-10-04T15:30:52.000Z", "endedAt": null,
  "updatedAt": "2026-10-04T03:30:52.000Z", "version": 1,
  "updates": [{ "at": "2026-10-04T03:45:00.000Z", "message": "L'eau atteint la rue des Serres...", "severity": "emergency" }]
}
```

Aucune donnée de l'agent émetteur n'est publique. `version` augmente à chaque mise à jour : le client ré-affiche une alerte que l'habitant avait fermée si sa version change. `updates` : les 5 dernières évolutions, la plus récente d'abord. Vue du personnel : les mêmes champs plus `createdBy` et `createdAt`.

#### Public (sans compte)

| Route | Rôle |
|---|---|
| `GET /api/public/alerts?zone=south` | `{ "zone": "south", "active": [Alert], "recentlyEnded": [Alert] }` : alertes en cours visant ce quartier ou toute la ville, la plus grave d'abord, et fins d'alerte des 6 dernières heures. Sans `zone` : toutes. 400 si quartier inconnu |
| `GET /api/public/alerts/zones` | Les 6 valeurs ci-dessus avec libellés fr/en, pour le choix « mon quartier » |
| `GET /api/public/alerts/:id` | Une alerte, même terminée. 404 sinon |

#### Personnel (`agent.alerts.manage`, agent validé)

| Route | Rôle |
|---|---|
| `GET /api/alerts?status=active\|ended&page=&limit=` | Historique des alertes |
| `GET /api/alerts/:id` | Détail |
| `POST /api/alerts` | Publier. **201** → `Alert` |
| `POST /api/alerts/:id/updates` | Faire évoluer une alerte en cours. **200** → `Alert` (`version` + 1). **409** `alert_ended` si terminée |
| `POST /api/alerts/:id/end` | Fin d'alerte. **200** → `Alert` terminée. **409** `alert_ended` si déjà terminée |

`POST /api/alerts` :

```json
{
  "title": "Montée inhabituelle de l'eau", "hazard": "flood", "severity": "warning", "zones": ["south"],
  "message": "Le niveau de l'eau monte anormalement le long du canal sud. Les rues basses peuvent être inondées dans l'heure.",
  "instructions": ["Montez à l'étage ou en hauteur", "Évitez les rues basses et le bord du canal"],
  "expiresInMinutes": 720
}
```

| Champ | Règle |
|---|---|
| `title` | 5 à 120 caractères |
| `hazard`, `severity` | Voir les tableaux |
| `zones` | Liste de quartiers, ou `["all"]` (jamais mélangé) |
| `message` | Ce qui se passe, 10 à 1000 caractères |
| `instructions` | Au plus 6 consignes de 3 à 160 caractères ; **au moins une** pour `warning` et `emergency` |
| `expiresInMinutes` | 15 min à 72 h ; par défaut selon la gravité |

`POST /api/alerts/:id/updates` : `{ "message": "...", "severity"?: "emergency", "instructions"?: [...], "expiresInMinutes"?: 360 }` (message 5 à 1000 caractères ; les consignes fournies remplacent les précédentes).
`POST /api/alerts/:id/end` : `{ "endMessage": "Le niveau de l'eau est redescendu. Vous pouvez regagner vos logements." }` (obligatoire).

Erreurs : 400 (message explicite), 401, 403 (`agent_not_validated` pour un agent non validé), 404, 409.

#### Assistant IA de rédaction — `POST /api/alerts/draft`

Quand l'eau monte, l'agent n'a pas le temps d'écrire un texte clair. L'assistant lit les **signalements ouverts du quartier des 3 dernières heures** (15 au plus) et propose une alerte complète : titre, gravité, message, consignes, durée. **Rien n'est publié** : l'agent relit, corrige, puis envoie le brouillon tel quel à `POST /api/alerts`. Même permission et même exigence d'agent validé que la publication.

```json
{ "zone": "south", "hazard": "flood", "notes": "Le canal a débordé au pont 2" }
```

| Champ | Règle |
|---|---|
| `zone` | Obligatoire : un quartier ou `all` |
| `hazard` | Optionnel : sans lui, l'assistant prend le danger le plus signalé dans le quartier |
| `notes` | Optionnel (3 à 1000 caractères) : ce que l'agent sait en plus. Suffit à lui seul s'il n'y a aucun signalement |

**200** →

```json
{
  "draft": {
    "title": "Inondations dans le quartier sud", "hazard": "flood", "severity": "warning", "zones": ["south"],
    "message": "Des montées des eaux sont constatées rue des Serres et au pont 2 du canal sud ; les déplacements y sont dangereux.",
    "instructions": ["Éloignez-vous immédiatement des zones inondées", "Ne traversez pas une rue couverte d'eau", "Évitez la rue des Serres et le pont 2"],
    "expiresInMinutes": 720
  },
  "source": "ai", "model": "space-bunny-free",
  "basedOn": { "signalements": 3, "urgent": 1, "withinHours": 3, "locations": ["Place du Marché", "Rue des Serres", "Canal sud, pont 2"] },
  "notice": "Brouillon à relire : vérifiez les faits, le quartier et les consignes avant de publier."
}
```

- **`source`** : `ai` si le modèle a répondu ; `template` sinon (clé absente, modèle lent ou réponse invalide). Dans ce cas, un modèle de texte par danger, avec des consignes validées à l'avance, rend un brouillon en moins de 100 ms. L'agent a **toujours** un brouillon.
- **Garde-fous** : chaque champ rendu par le modèle est revalidé (longueurs, gravité connue, au plus 6 consignes). Si un signalement urgent existe, la gravité ne descend jamais sous celle des règles de la ville. Les données des habitants sont présentées au modèle comme des faits à résumer, jamais comme des instructions.
- **Données personnelles** : seuls le type, la priorité, le lieu et l'ancienneté des signalements sont envoyés au modèle. **Jamais** la description (qui peut contenir des données de santé), le téléphone ou l'identité du déclarant. Les e-mails et numéros présents dans un lieu ou dans la note sont retirés avant l'envoi.
- Durée typique : 5 à 12 s avec le modèle gratuit. Le client doit afficher « Rédaction en cours… » et laisser l'agent écrire lui-même entre-temps.

Erreurs : 400, 403 (`agent_not_validated`), **422** `nothing_to_draft` (aucun signalement récent dans ce quartier et aucune note), **429** au-delà de 10 brouillons par minute et par compte (`AI_DRAFT_RATE_LIMIT_PER_MINUTE`).
Vérification : `node tools/alert-draft-check.mjs 5000` (avec l'IA), ou API lancée avec `LLM_BASE_URL=http://127.0.0.1:9/v1` puis `node tools/alert-draft-check.mjs 5000 template` (repli).

#### Temps réel (public)

Sur le **canal public** socket.io (le même que les annonces, sans jeton) : `io(API_ORIGIN)`.

| Événement | Contenu |
|---|---|
| `alert:published` | `Alert` |
| `alert:updated` | `Alert` (nouvelle `version`) |
| `alert:ended` | `Alert` terminée (`endMessage`) |

Tout le monde reçoit chaque événement ; le client filtre sur `zones` (quartier de l'habitant ou `all`).

Actions d'audit : `alert.draft`, `alert.publish`, `alert.update`, `alert.end` (`entityType: "alerts"`).

**Pas encore fait** : pas de notification push / SMS hors de la plateforme (l'habitant doit avoir une page ouverte ou ouvrir le site) ; pas de quartier enregistré sur le compte (choisi côté client).

---

### Transports — `/api/public/transport` (public) et `/api/transport` (personnel)

Deux besoins, une seule rubrique :

1. **Consulter les horaires et infos** des transports municipaux, et comprendre tout de suite ce qui compte pour sa situation, **sans parcourir plusieurs écrans** : la fiche d'un arrêt donne, sur une seule réponse, les prochains passages de chaque ligne dans chaque sens, les lignes coupées et une **phrase qui dit quoi faire**.
2. **Plusieurs lignes interrompues** : l'agent déclare les lignes touchées en une fois ; une alerte « Transports perturbés » part vers les quartiers desservis ; chaque habitant peut demander « comment aller de A à B **maintenant** ? » et reçoit un trajet qui évite les sections coupées, bus de remplacement compris, avec heure de départ et d'arrivée.

Tables : `transport_lines` (6 lignes semées au démarrage, table vide uniquement) et `transport_disruptions`. Vérification de bout en bout : `node tools/transport-check.mjs 5000` (API locale ; lance aussi une seconde instance « en panne » sur le port suivant ; crée puis supprime ses données de test).

| Ligne | Nom | Arrêts |
|---|---|---|
| `N1` | Navette Nord | Dôme Nord – Serres Nord – Place des Pionniers – Gare Centrale |
| `S1` | Navette Sud | Gare Centrale – Marché – Rue des Serres – Canal Sud – Dôme Sud |
| `T1` | Tram Est–Ouest | Porte Ouest – Hôpital – Gare Centrale – Place des Pionniers – Université – Porte Est |
| `T2` | Tram des Dômes | Dôme Nord – Université – Porte Est – Dôme Sud |
| `B3` | Bus des Serres (lundi–samedi) | Dôme Nord – Serres Nord – Hôpital – Porte Ouest |
| `C1` | Téléphérique du Canal | Porte Ouest – Canal Sud |

Horaires : départs des deux terminus de `first` à `last`, toutes les `frequencyMinutes` minutes (plus souvent aux heures de pointe), `minutesBetweenStops` minutes entre deux arrêts, jours de service ISO (1 = lundi). Heure locale : `TRANSPORT_TIMEZONE`.

#### Public (sans compte)

| Route | Rôle |
|---|---|
| `GET /api/public/transport?lines=S1,T1` | État du réseau : `{ summary: { interrupted, delayed, normal }, lines: [Line], stale, savedAt }`, lignes touchées d'abord. `lines` : seulement « mes lignes » |
| `GET /api/public/transport/stops` | Arrêts : `[{ name, lines, unservedBy, served }]` (autocomplétion) |
| `GET /api/public/transport/stops/:name` | **Fiche d'un arrêt, tout sur un écran** (voir ci-dessous). Accents et majuscules indifférents (`marche` → Marché). 404 + `suggestions` sinon |
| `GET /api/public/transport/lines/:code` | Une ligne : état, infos, grille horaire (`timetable`), prochains départs des terminus |
| `GET /api/public/transport/journey?from=&to=` | **Trajet de remplacement** (voir ci-dessous). 400 `unknown_stop` + `suggestions` si un arrêt est mal tapé |
| `GET /api/public/transport/disruptions/:id` | Une interruption |

`Line` : `{ code, name, mode, modeLabel, color, stops, zones, zoneLabels, info: { days: { fr: "Du lundi au samedi" }, first, last, frequencyMinutes, peaks, travelMinutes, accessible, notes }, state: "normal" | "delayed" | "interrupted", stateLabel, disruptions: [Disruption] }`.

`Disruption` : `{ id, line, kind, kindLabel, headline: { fr: "Ligne S1 interrompue entre Marché et Dôme Sud" }, section, unservedStops: ["Rue des Serres", "Canal Sud"], reason, alternatives: [{ kind, kindLabel, text, line?, from?, to?, extraMinutes? }], suggestedLines: [{ code, name, color, servesStops }], startsAt, expectedEndAt, alertId }`. `suggestedLines` est **calculé** : les lignes qui desservent encore les arrêts touchés, même si l'agent n'a rien saisi.

`GET /api/public/transport/stops/Canal%20Sud` :

```json
{
  "stop": "Canal Sud", "nowLabel": "08:18",
  "advice": "La ligne S1 ne passe plus ici (Panne d'alimentation électrique sur le réseau sud) : bus de remplacement toutes les 15 min entre Marché et Dôme Sud. Prochain départ : ligne C1 direction Porte Ouest, à 08:21 (dans 3 min).",
  "lines": [
    { "line": { "code": "S1", "name": "Navette Sud", "color": "#16A34A" },
      "directions": [{ "towards": "Dôme Sud", "served": false, "delayed": false, "departures": [] }, { "towards": "Gare Centrale", "served": false, "departures": [] }],
      "disruption": { "headline": { "fr": "Ligne S1 interrompue entre Marché et Dôme Sud" }, "alternatives": [...], "suggestedLines": [...] } },
    { "line": { "code": "C1" }, "directions": [{ "towards": "Porte Ouest", "served": true, "departures": [{ "time": "08:21", "inMinutes": 3, "tomorrow": false, "dayOffset": 0 }] }], "disruption": null }
  ]
}
```

Afficher `advice` en premier, en gros : c'est la réponse à « qu'est-ce que je fais ? ». Une ligne qui ne passe plus n'affiche **aucun horaire** (pas d'horaire trompeur).

`GET /api/public/transport/journey?from=Rue des Serres&to=Gare Centrale` :

```json
{
  "from": "Rue des Serres", "to": "Gare Centrale",
  "usual": { "summary": { "fr": "Prenez la ligne S1 ..." }, "affected": true,
             "disruptions": [{ "headline": { "fr": "Ligne S1 interrompue entre Marché et Dôme Sud" }, "reason": "...", "expectedEndAt": "..." }] },
  "options": [{
    "summary": { "fr": "Prenez le bus de remplacement de la ligne S1 (direction Marché) jusqu'à Marché, puis la ligne S1 (direction Gare Centrale) jusqu'à Gare Centrale" },
    "departure": "08:25", "arrival": "08:37", "waitMinutes": 7, "durationMinutes": 19, "transfers": 1, "delayed": false, "usesReplacement": true, "tomorrow": false,
    "legs": [{ "line": { "code": "R12", "name": "Bus de remplacement S1", "replacement": true }, "from": "Rue des Serres", "to": "Marché", "direction": "Marché", "stops": 1, "departure": "08:25", "arrival": "08:30" }, ...]
  }],
  "otherSolutions": [], "message": null
}
```

- `usual` : le trajet habituel (réseau sans interruption) et s'il est touché : « Votre trajet habituel est coupé : Ligne S1 interrompue... ».
- `options` : jusqu'à 3 trajets classés par **heure d'arrivée réelle** selon les horaires ; une correspondance de plus n'est proposée que si elle fait arriver plus tôt. Les sections interrompues sont évitées ; les bus de remplacement déclarés sont utilisables (moins fréquents, plus lents) ; une section perturbée compte une minute de plus par arrêt.
- Aucun trajet : `options` vide, `message`, et `otherSolutions` (navette à la demande, à pied...) des lignes touchées.

#### Personnel (`agent.transport.manage` ; déclarer, modifier et rétablir : agent **validé**)

| Route | Rôle |
|---|---|
| `GET /api/transport/lines` | Lignes, arrêts et état (pour le formulaire) |
| `GET /api/transport/disruptions?status=active\|ended&page=&limit=` | Historique |
| `POST /api/transport/disruptions` | Déclarer une ou **plusieurs lignes** touchées. **201** → `{ disruptions, alert }` |
| `PATCH /api/transport/disruptions/:id` | Modifier (`kind`, `fromStop`/`toStop`, `reason`, `alternatives`, `expectedEndAt`). L'alerte liée est mise à jour |
| `POST /api/transport/disruptions/:id/end` | Ligne rétablie. Quand **toutes** les lignes d'une alerte sont rétablies, l'alerte se termine seule : « Trafic rétabli sur les lignes S1, T1, C1. » |

`POST /api/transport/disruptions` :

```json
{
  "reason": "Panne d'alimentation électrique sur le réseau sud",
  "expectedEndAt": "2026-10-04T11:00:00.000Z",
  "publishAlert": true,
  "items": [
    { "line": "S1", "kind": "interrupted", "fromStop": "Marché", "toStop": "Dôme Sud",
      "alternatives": [
        { "kind": "replacement_bus", "from": "Marché", "to": "Dôme Sud", "text": "Bus de remplacement toutes les 15 min entre Marché et Dôme Sud", "extraMinutes": 10 },
        { "kind": "line", "line": "T2", "text": "Pour Dôme Sud, prenez aussi le tram T2" }
      ] },
    { "line": "T1", "kind": "delayed" },
    { "line": "C1", "kind": "interrupted" }
  ]
}
```

| Champ | Règle |
|---|---|
| `reason` | Cause, 5 à 200 caractères (commune aux lignes déclarées ensemble) |
| `expectedEndAt` | Optionnel : reprise prévue, dans les 72 h. Information pour l'habitant : la ligne n'est rétablie que par un agent |
| `publishAlert` | Défaut `true` : publie UNE alerte `hazard: "transport"`, gravité `watch`, vers les quartiers desservis, avec les consignes écrites automatiquement (solution de l'agent, sinon « circulation ralentie, prévoyez plus de temps » pour une ligne perturbée, sinon une ligne voisine qui dessert encore les arrêts) et « Votre trajet de remplacement : rubrique Transports » |
| `items` | 1 à 10 lignes, chacune une seule fois. **409** si une ligne a déjà une interruption en cours (la modifier) |
| `items[].kind` | `interrupted` (plus rien ne passe) ou `delayed` (ça roule, avec retards) |
| `items[].fromStop`, `toStop` | Section touchée : deux arrêts de la ligne, ou absents pour toute la ligne |
| `items[].alternatives` | Au plus 5 : `line` (code d'une autre ligne), `replacement_bus` (`from` et `to` : arrêts de la ligne ; devient utilisable dans le calcul de trajet), `walk`, `on_demand`, `other`. `text` : 3 à 160 caractères, phrase à lire telle quelle |

Une alerte « transport » porte en plus `transport: [{ disruptionId, line: { code, name, color }, kind, status, headline }]` (dans `GET /api/public/alerts` et les événements temps réel) : le bandeau peut afficher les pastilles de lignes et un bouton « Trouver un autre trajet ».

**Temps réel** (canal public) : `transport:updated` → `{ lines: [{ code, state }] }` à chaque déclaration, modification ou rétablissement ; le client recharge l'état du réseau.

Actions d'audit : `transport.disruption.create`, `transport.disruption.update`, `transport.disruption.end`, `alert.publish`.

**Pas encore fait** : pas d'écran d'administration des lignes (elles sont semées ; modification directe en base) ; horaires théoriques uniquement (pas de position des véhicules en temps réel).

---

### Panne de réseau : fonctions essentielles et informations récupérables

Une panne (base de données injoignable, réseau interne coupé, connexion perdue côté habitant) peut rendre des fonctions indisponibles. Ce qui reste garanti :

| Situation | Ce qui se passe |
|---|---|
| **Base de données en panne** | Les lectures publiques utiles en crise (alertes, état et horaires des transports, fiche d'arrêt, trajet de remplacement, kit essentiel) sont servies depuis leur **dernière version connue** au lieu d'une erreur, avec `stale: true`, `savedAt` et les en-têtes `X-Data-Stale: 1` / `X-Data-Saved-At`. Ces copies sont gardées en mémoire **et sur disque** (`SNAPSHOT_DIR`, réécrites dès que le contenu change) : elles survivent à un redémarrage de l'API pendant la panne. Une lecture qui dépasse `DB_READ_TIMEOUT_MS` (3 s) bascule aussi sur la copie |
| **Habitant hors ligne** | Le site garde le **kit essentiel** (`/api/public/essentials`) sur l'appareil et le relit sans réseau : numéro d'urgence, conduite à tenir, alertes en cours, horaires bruts des lignes (pour calculer les prochains passages sans réseau), services municipaux |
| **Signalement sans réseau** | Le client garde le signalement sur l'appareil avec un `clientRef` et l'heure du constat (`reportedAt`), et le renvoie au retour de la connexion : un renvoi en double ne crée **jamais** de second signalement. Pendant une panne de base, l'envoi répond `503` avec `Retry-After` : le client réessaie seul |
| **Fonctions avec compte** (connexion, demandes, rendez-vous) | Indisponibles pendant une panne de base (`503` + message clair) ; `GET /api/status` dit lesquelles |

#### `GET /api/public/essentials` (sans compte)

Une seule réponse compacte (~15 Ko), **toujours servie** : si la base est en panne et qu'aucune copie n'existe, elle contient au moins `emergency` et `offlineGuide` (`complete: false`).

```json
{
  "emergency": { "number": "112", "label": { "fr": "Urgence vitale : appelez le 112" }, "note": { "fr": "Un appel d'urgence passe même sans internet." } },
  "offlineGuide": { "fr": ["En cas d'urgence vitale, appelez le 112 : pas besoin d'internet.", "Les alertes et horaires affichés sont ceux de la dernière mise à jour (l'heure est indiquée).", "..."] },
  "alerts": [Alert],
  "transport": { "lines": [{ "code": "N1", "name": "Navette Nord", "color": "#2563EB", "state": "interrupted", "stops": [...], "info": {...},
                             "minutesBetweenStops": 3, "serviceDays": [1,2,3,4,5,6,7], "terminusDepartures": ["05:30", "05:40", "..."],
                             "disruptions": [{ "headline": {...}, "reason": "...", "unservedStops": [...], "alternatives": ["Prenez le tram T1 à Place des Pionniers"] }] }] },
  "services": [{ "code": "transport", "name": "Transports et mobilité", "description": "...", "icon": "bus" }],
  "version": "376aa4f6b725915b", "stale": false, "savedAt": "2026-10-04T05:16:21.606Z", "complete": true
}
```

- `ETag` : renvoyer `If-None-Match` → **304** si rien n'a changé (rien à retélécharger sur un réseau faible).
- Prochains passages sans réseau : à l'arrêt d'indice `i`, vers la fin de la ligne : `terminusDepartures[k] + i × minutesBetweenStops` ; vers le début : `(nombre d'arrêts − 1 − i) × minutesBetweenStops`. Seulement les jours de `serviceDays`.
- À récupérer au chargement du site, puis à chaque `alert:*` / `transport:updated` reçu, et à la reconnexion du canal temps réel.

#### `GET /api/status`

État des services en clair, à appeler quand une requête échoue (pas de limitation de débit, `Cache-Control: no-store`) :

```json
{
  "status": "degraded", "database": "down", "downSince": "2026-10-04T05:16:30.000Z", "lastUpdateAt": "2026-10-04T05:16:21.606Z",
  "features": [
    { "key": "emergency", "available": true, "mode": "live", "label": { "fr": "Numéro d'urgence et conduite à tenir" } },
    { "key": "alerts", "available": true, "mode": "last_known", "label": { "fr": "Alertes en cours" } },
    { "key": "transport", "available": true, "mode": "last_known", "label": { "fr": "Horaires et état des transports" } },
    { "key": "signalements", "available": false, "mode": "queued", "fallback": { "fr": "Votre signalement est gardé sur l'appareil et sera transmis automatiquement." } },
    { "key": "account", "available": false, "mode": "unavailable", "label": { "fr": "Compte, demandes et rendez-vous" } },
    { "key": "ai", "available": true, "mode": "live" }
  ],
  "message": { "fr": "Service partiellement indisponible. Les alertes, les horaires de transport et le numéro d'urgence restent consultables. Les signalements seront transmis dès le retour du service ; en cas d'urgence vitale, appelez le 112." }
}
```

`mode` : `live` (à jour), `last_known` (dernière version connue), `queued` (gardé sur l'appareil, envoyé plus tard), `unavailable`.

Le personnel peut aussi **annoncer** une panne aux habitants avec une alerte `hazard: "network"` (« Panne de réseau / communications »), consignes par défaut de l'assistant IA : appeler le 112 sans internet, informations déjà chargées consultables, signalements envoyés au retour du réseau.

Vérifié par `tools/transport-check.mjs` (partie 5) : une seconde instance de l'API, branchée sur une base injoignable, sert alertes, état des transports, fiche d'arrêt, trajet et kit essentiel depuis les copies, et `/api/status` passe en `degraded`.

---

### Incident sur la plateforme : informations essentielles, consignes et coordonnées utiles

Demande citoyenne : *« Lorsqu'un incident touche la plateforme, je n'ai pas forcément besoin de tout faire. Je voudrais au moins continuer à consulter les informations essentielles, les consignes et les coordonnées utiles. »*

| Besoin | Réponse | Disponible si la base est en panne ? |
|---|---|---|
| Savoir ce qui marche encore, sans tout essayer | `GET /api/status` + **avis d'incident** publié par un administrateur (`PUT /api/platform/notice`) | Oui (avis stocké dans un fichier) |
| Les consignes | Guide permanent « Que faire en cas de... » : `GET /api/public/guide` (10 dangers, avant / pendant / après, sac d'urgence) | **Toujours** (écrit dans le code) |
| Les coordonnées utiles | Annuaire tenu par le personnel : `GET /api/public/contacts?zone=` (urgences, cellule de crise, santé, abris, eau potable, dépannage, transports, mairie) | Oui (dernière version connue) |
| Tout, en un seul endroit | Page de secours **`GET /secours`** (HTML sans JavaScript, servie par l'API même si le site principal est en panne) et kit `GET /api/public/essentials` | Oui ; au pire, numéro d'urgence + consignes |

Vérification de bout en bout : `node tools/essentials-check.mjs 5000` (API locale ; simule deux pannes avec des instances supplémentaires sur les ports +1 et +2, dont une **sans aucune copie de secours** ; crée puis supprime ses données de test).

#### Consignes — `GET /api/public/guide`, `GET /api/public/guide/:key`

Clés = dangers des alertes (`alert.hazard`) : `flood`, `heavy_rain`, `cyclone`, `fire`, `power_outage`, `water_outage`, `health`, `security`, `transport`, `network`. Une alerte « flood » renvoie donc au guide « flood ».

```json
{
  "entries": [{
    "key": "flood",
    "title": { "fr": "Montée des eaux, inondation", "en": "Rising water, flood" },
    "summary": { "fr": "Mettez-vous en hauteur et ne traversez jamais l'eau.", "en": "..." },
    "before": { "fr": ["Repérez un étage ou un lieu en hauteur où vous abriter", "..."], "en": ["..."] },
    "during": { "fr": ["Montez à l'étage ou en hauteur ; n'allez jamais au sous-sol", "...", "Danger pour une personne : appelez le 112"], "en": ["..."] },
    "after":  { "fr": ["Attendez l'autorisation avant de rentrer chez vous", "..."], "en": ["..."] }
  }],
  "kit": { "fr": ["Eau : 2 litres par personne et par jour", "Nourriture qui se conserve", "Lampe et piles", "..."], "en": ["..."] }
}
```

Le numéro d'urgence (`EMERGENCY_NUMBER`, défaut `112`) est inséré dans les textes. 404 pour une clé inconnue. `Cache-Control: public, max-age=3600`. Le contenu se modifie dans [src/content/safetyGuide.ts](src/content/safetyGuide.ts).

#### Coordonnées utiles — `GET /api/public/contacts?zone=south` (sans compte)

```json
{
  "zone": "south",
  "categories": [
    { "category": "emergency", "label": { "fr": "Urgences" }, "contacts": [
      { "id": 1, "label": "Secours — urgence vitale", "category": "emergency", "phone": "112", "phoneHref": "tel:112", "email": null, "address": null,
        "zone": null, "zoneLabel": null, "openingHours": null, "available24h": true, "description": "Personne en danger, incendie, accident grave...",
        "isOpen": true, "statusNote": null, "updatedAt": "..." } ] },
    { "category": "shelter", "label": { "fr": "Abris et points de rassemblement" }, "contacts": [
      { "label": "Abri du Dôme Sud", "address": "Dôme Sud, niveau 2 (hors d'eau)", "zone": "south", "isOpen": false, "statusNote": "Complet : rejoignez le gymnase du centre", "...": "..." } ] }
  ],
  "stale": false, "savedAt": "..."
}
```

- Catégories dans l'ordre où on les cherche : `emergency`, `crisis`, `health`, `shelter`, `water`, `utilities`, `transport`, `city`, `other`.
- `zone` : les contacts de ce quartier **et** ceux de toute la ville (`zone: null`). 400 si quartier inconnu.
- `phoneHref` : lien d'appel direct (`tel:`). `isOpen` / `statusNote` : état d'un lieu (abri complet, point d'eau fermé), à afficher pour `shelter`, `water`, `health`.
- 10 contacts de départ semés sur une table vide (numéros courts `3xxx` et e-mails `@terranova.example` **de démonstration**, à remplacer).

Personnel (`agent.contacts.manage` ; écrire : agent **validé**) :

| Route | Rôle |
|---|---|
| `GET /api/contacts` | Tous, y compris désactivés (`isActive`, `sortOrder`, `serviceId` en plus) |
| `POST /api/contacts` | `{ label, category, phone?, email?, address?, zone?, openingHours?, available24h?, description?, isOpen?, statusNote?, serviceId?, sortOrder?, isActive? }` — au moins un téléphone, un e-mail ou une adresse. **201** |
| `PATCH /api/contacts/:id` | Mise à jour partielle ; en pleine crise : `{ "isOpen": false, "statusNote": "Complet : rejoignez le gymnase du centre" }` |
| `DELETE /api/contacts/:id` | **204** |

Règles : `label` 2 à 150 ; `phone` chiffres, `+`, espaces, `.-()` (3 à 30) ; `email` valide ; `zone` un quartier ou `null` (toute la ville) ; `openingHours` 150 ; `description` 300 ; `statusNote` 255. Actions d'audit : `contact.create`, `contact.update`, `contact.delete`.

#### Avis d'incident — `PUT /api/platform/notice`, `DELETE /api/platform/notice` (`admin.platform.manage`)

```json
{
  "message": "Incident en cours : les rendez-vous et les demandes en ligne sont indisponibles. Les alertes, les consignes et les coordonnées utiles restent consultables.",
  "messageEn": "Incident in progress: ...",
  "severity": "warning",
  "affected": ["account"]
}
```

- `message` 10 à 500 caractères : ce qui ne marche pas, ce qui marche encore, jusqu'à quand. `severity` : `info` ou `warning` (défaut). `affected` : fonctions à marquer indisponibles parmi `alerts`, `transport`, `contacts`, `signalements`, `account`, `ai`.
- L'avis apparaît dans `GET /api/status` (`status: "incident"`, `message` = l'avis, `notice`, fonctions concernées `available: false` et `declaredByNotice: true`), dans le kit essentiel (`notice`) et en bandeau sur la page de secours. `DELETE` le retire (**204**, 404 s'il n'y en avait pas).
- Stocké dans **`data/platform-notice.json`** (`PLATFORM_NOTICE_FILE`), pas en base : il reste lisible pendant une panne de la base. Si la panne empêche même de se connecter, l'exploitant peut écrire ce fichier à la main (mêmes champs), il est relu sans redémarrage.
- Actions d'audit : `platform.notice.set`, `platform.notice.clear`.

`GET /api/status` → `status` : `ok`, `incident` (avis publié, base disponible) ou `degraded` (base injoignable ; `details` garde alors le message technique si un avis existe). Fonctions : `emergency`, `guide` (toujours `live`), `alerts`, `contacts`, `transport` (`live` ou `last_known`), `signalements` (`live` ou `queued`), `account`, `ai`.

#### Page de secours — `GET /secours` (aussi `GET /api/public/secours`)

Une page HTML **autonome** (~17 Ko), sans JavaScript ni ressource externe (CSP : aucun script autorisé), lisible sur téléphone, en mode sombre et à l'impression. `?lang=en` pour l'anglais. Dans l'ordre :

1. Bouton **« Urgence vitale : appelez le 112 »** (lien `tel:`) ;
2. Avis d'incident ou bandeau de panne, puis l'état de chaque fonction (disponible, dernières infos connues, envoi différé, indisponible) ;
3. Alertes en cours avec leurs consignes ;
4. Coordonnées utiles cliquables, avec l'état des abris et points d'eau ;
5. Transports : lignes touchées d'abord, solutions de remplacement ;
6. « Que faire en cas de… » : un bloc dépliable par danger (déplié d'office pour les dangers des alertes en cours, et pour la panne quand la plateforme est en difficulté) ;
7. Sac d'urgence et conduite à tenir sans connexion.

Servie par l'API elle-même : elle reste accessible si le site principal (front) est en panne. Si la base est en panne, elle affiche la dernière version connue avec sa date ; sans aucune copie, le numéro d'urgence et toutes les consignes restent affichés. Tout texte venant de la base est échappé. `ETag` + `Cache-Control: no-cache`. Le site peut la mettre en cache (service worker) et y renvoyer quand il ne répond plus.

Au démarrage, l'API lit une première fois les informations essentielles : une copie de secours existe ainsi avant la première visite.

---

### Journal d'audit — `/api/audit-logs` 🛡️

#### `GET /api/audit-logs?userId=&action=&entityType=&entityId=&page=&limit=`

`entityType` + `entityId` : tout ce qui a touché un dossier précis (« qui a consulté le compte n° 12 ? »), par exemple `?entityType=users&entityId=12`.

**200** → `{ "logs": [AuditLog], "page": 1, "limit": 20, "total": 134 }`, du plus récent au plus ancien. Chaque `AuditLog` contient `user` (`{ id, email, firstName, lastName }`, ou `null` si l'action est anonyme ou le compte supprimé).

Deux sortes de lignes coexistent :

**1. Audit automatique de chaque requête** (middleware global, [audit.middleware.ts](src/middlewares/audit.middleware.ts)). Format de `action` : `METHOD /chemin statut`, avec les ids numériques remplacés par `:id`.

```json
{ "userId": 4, "action": "GET /api/services/:id 200", "entityType": "services", "entityId": 1, "ipAddress": "::1" }
{ "userId": null, "action": "GET /api/users 401", "entityType": "users", "entityId": null, "ipAddress": "203.0.113.7" }
```

- `userId` : l'utilisateur connecté, ou `null` pour une requête anonyme (route publique, token absent ou invalide). Pour `login` et `register`, l'identité figure sur la ligne métier correspondante (voir plus bas).
- La **query string n'est jamais enregistrée** (elle peut contenir des recherches de l'utilisateur), ni le corps de la requête, ni les tokens.
- Ne sont pas enregistrés : `OPTIONS` (préflight CORS), `GET /api/health`, et les 404 d'utilisateurs non connectés (bruit de scanners). Un 404 d'un utilisateur connecté sur une route qui n'existe pas n'est pas non plus enregistré : l'identité n'est lue qu'une fois la route trouvée.
- Mode `AUDIT_REQUESTS=writes` : seuls `POST`/`PUT`/`PATCH`/`DELETE` et les refus 401/403 sont enregistrés (les lectures `GET` réussies sont ignorées).
- Les lignes sont mises en file en mémoire et insérées **en lot toutes les secondes** : l'audit n'ajoute pas de latence aux réponses. Au plus ~1 seconde de lignes peut être perdue en cas de crash brutal du serveur ; un arrêt normal (`SIGINT`/`SIGTERM`) les écrit avant de quitter.
- La table grossit à chaque requête : prévoyez un nettoyage périodique, par exemple `DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL 90 DAY`.

Pour ne voir que ces lignes : `GET /api/audit-logs?action=GET /api/services 200` (le filtre est sur l'`action` exacte).

**2. Événements métier précis**, écrits par les contrôleurs. Actions enregistrées : `user.register`, `login`, `login.failed`, `login.blocked`, `logout.all`, `password.change`, `profile.update`, `user.activate`, `user.deactivate`, `role.assign`, `role.remove`, `role.create`, `role.update`, `role.delete`, `role.permission.grant`, `role.permission.revoke`, `role.permission.sync`, `permission.create`, `permission.update`, `permission.delete`, `service.create`, `service.update`, `service.delete`, `announcement.create`, `announcement.update`, `announcement.published`, `announcement.archived`, `announcement.draft`, `announcement.delete`, `contact.send`, `contact.new`, `contact.read`, `contact.processed`, `request.create`, `request.assign`, `request.priority`, `request.pending`, `request.in_progress`, `request.resolved`, `request.rejected`.

---

## Matrice rôles / permissions

| Permission | citizen | agent | admin |
|---|:-:|:-:|:-:|
| `citizen.account.create` | ✅ | ✅ | ✅ |
| `citizen.session.login` | ✅ | ✅ | ✅ |
| `citizen.message.send` | ✅ | ✅ | ✅ |
| `citizen.services.view` | ✅ | ✅ | ✅ |
| `citizen.announcements.view` | ✅ | ✅ | ✅ |
| `citizen.home.view` | ✅ | ✅ | ✅ |
| `agent.dashboard.access` | | ✅ | ✅ |
| `agent.requests.view` | | ✅ | ✅ |
| `admin.users.manage` | | | ✅ |
| `admin.services.manage` | | | ✅ |
| `agent.announcements.manage` | | ✅ | ✅ |
| `agent.messages.manage` | | ✅ | ✅ |
| `citizen.signalements.create` | ✅ | ✅ | ✅ |
| `citizen.signalements.view` | ✅ | ✅ | ✅ |
| `agent.signalements.view` | | ✅ | ✅ |
| `agent.signalements.manage` | | ✅ | ✅ |
| `agent.alerts.manage` | | ✅ (validé) | ✅ |
| `agent.transport.manage` | | ✅ (validé pour déclarer) | ✅ |
| `agent.contacts.manage` | | ✅ (validé pour modifier) | ✅ |
| `admin.platform.manage` | | | ✅ |

Cette matrice est celle des scripts d'insertion (blocs 1-2 et bloc 3) ; elle peut évoluer via `/api/roles/:id/permissions`. Consultez `GET /api/roles` pour l'état réel.

## Sécurité web

Une tentative d'exploitation de faille a été détectée sur des plateformes similaires : voici ce qui protège les données sensibles, et comment le **constater**.

### Vérifier soi-même

```bash
BOT_PROTECTION=off TRUST_PROXY=1 PORT=5000 npm run dev      # API locale (jamais la production)
node tools/security-check.mjs 5000
```

[tools/security-check.mjs](tools/security-check.mjs) rejoue de **vraies attaques** : un citoyen contre les données d'un autre, élévation de privilèges, jetons falsifiés, injections SQL, faux fichiers, traversée de répertoire, scanners, CORS, fuite d'informations. Chaque ligne affiche ✅ (l'attaque échoue) ou ❌ (faille). État actuel : **77 défenses efficaces, 0 faille** (au départ : 32 et 8 failles). Il crée des comptes `sec_*@example.com` et les supprime ensuite ; code de sortie 1 s'il reste une faille, donc utilisable en intégration continue.

### Ce qui a été trouvé et corrigé

| Faille réelle | Correction |
|---|---|
| Un fichier HTML/JavaScript déguisé en image (`image/png` annoncé) était accepté | Les premiers octets du fichier sont vérifiés (PNG, JPEG, GIF, WebP) ; sinon supprimé et refusé |
| Aucun en-tête de sécurité HTTP, `X-Powered-By: Express` annoncé | En-têtes ci-dessous ; `X-Powered-By` retiré |
| Données personnelles pouvant être mises en cache (ordinateur partagé, proxy) | `Cache-Control: no-store` sur toute réponse authentifiée et sur `/api/auth/*` |
| Fichiers servis sans `nosniff` ni sandbox | `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Content-Disposition: inline` |
| Sondes d'attaque (injection SQL dans une adresse, scanner `sqlmap`, `/.env`...) acceptées sans réaction | Détection, refus, **blocage de l'adresse** et trace d'audit (voir plus bas) |
| Un agent inscrit librement pouvait lister, **modifier** et **désactiver** tous les comptes citoyens | Agent « non validé » (voir plus bas) |

Ce qui tenait déjà et reste vérifié à chaque lancement : accès aux données d'autrui (`404` pour un identifiant qui n'est pas à soi), droits à chaque requête, `alg:none` et secrets devinés refusés, requêtes SQL paramétrées, aucun hachage ni mot de passe dans les réponses, cookie `HttpOnly`/`SameSite`, CORS fermé aux sites tiers.

### En-têtes de sécurité (visibles dans l'onglet Réseau)

| En-tête | Effet |
|---|---|
| `X-Content-Type-Options: nosniff` | Un fichier n'est jamais interprété autrement que son type annoncé |
| `X-Frame-Options: DENY` + `frame-ancestors 'none'` | Aucun site tiers ne peut afficher l'API dans un cadre |
| `Content-Security-Policy: default-src 'none'` | Rien n'est exécutable depuis une réponse de l'API |
| `Referrer-Policy: no-referrer` | Aucune adresse de page n'est transmise |
| `Cross-Origin-Resource-Policy: same-site` (`cross-origin` pour `/uploads`) | Un site tiers ne peut pas inclure les réponses ; les images restent affichables par le front |
| `Permissions-Policy` | Caméra, micro, géolocalisation, paiement désactivés |
| `Strict-Transport-Security` | HTTPS imposé au navigateur ; envoyé **seulement** sur une connexion HTTPS |

CORS : liste fermée de méthodes et d'en-têtes ; `Retry-After` est **exposé** (sinon le front ne peut pas le lire entre deux origines) ; le préflight est gardé 10 minutes. `POST /auth/refresh` et `/auth/logout` refusent (403 `origin_not_allowed`) une requête dont l'`Origin` n'est pas le site légitime, en plus de `SameSite=Lax`.

### Sondes d'attaque : détection et blocage

Le middleware [attackGuard](src/middlewares/attackGuard.middleware.ts) examine l'**adresse** (chemin et paramètres, bruts et décodés deux fois) et l'**identité du client**, jamais le contenu d'un formulaire : un habitant peut écrire « select » ou une balise dans un message sans être un pirate. Il reconnaît injections SQL (`UNION SELECT`, `' OR 1=1`, `; DROP`, `SLEEP(`...), scripts dans l'adresse, traversée de répertoire (`../`, `%2e%2e`), Log4Shell, fichiers que cherche un scanner (`/.env`, `/.git`, `/wp-login.php`, `/phpmyadmin`...) et outils connus (`sqlmap`, `nikto`, `nmap`...). De vraies recherches (`l'été`, `O'Brien`, `select`, `100%`) ne sont **pas** prises pour des attaques (testé).

- Requête refusée : **400** `{ "code": "request_rejected" }` (**403** pour un outil d'attaque connu).
- Chaque détection vaut 4 points pour l'adresse IP ; à 8 points elle est **bloquée 15 minutes pour toute l'API** : **429** `{ "code": "bot_blocked" }`. Les autres visiteurs ne sont pas touchés.
- Trace : audit `bot.attack_probe` (le type d'attaque est dans `entityType` : `sqli`, `xss`, `traversal`, `rce`, `scanner_path`, `scanner_agent`) et `bot.blocked`, une ligne `[BOT]` dans le journal, et le tableau `GET /api/security/bots`. Une adresse déjà bloquée n'écrit plus rien en base.
- **`TRUST_PROXY` doit être réglé en production** (voir « Charge et stabilité ») : sans lui, le blocage par adresse est désactivé (et signalé une fois dans le journal) pour ne pas bloquer tous les habitants à la fois.
- Réglage : `ATTACK_GUARD=on` (défaut) | `monitor` (détecte sans refuser) | `off`.

### Inscription libre en agent : données protégées autrement

L'inscription libre en agent est un **choix de produit** et reste ouverte. Or un agent voit des données de citoyens et peut administrer leurs comptes. Pour que cela ne donne pas accès à tout, il y a deux niveaux, **sans changement de base de données** (on s'appuie sur `role_user.assigned_by`, vide quand le rôle vient d'une auto-inscription) :

| | Agent **non validé** (inscrit seul) | Agent **validé** (un admin a attribué ou confirmé le rôle) et administrateur |
|---|---|---|
| Traiter demandes, rendez-vous, annonces | oui | oui |
| Coordonnées d'un citoyen (`/citizen-accounts`) | nom + e-mail partiel (`a***@example.com`), **ni téléphone ni adresse** | complètes |
| E-mail de l'expéditeur d'un message de contact | partiel | complet |
| Modifier ou désactiver un compte citoyen | **403** `agent_not_validated` | oui |
| Consultations de dossiers par minute | **30** puis 429 `sensitive_rate_limited` | **150** puis 429 |

Un administrateur voit les agents en attente (`GET /api/users/pending-agents`) et les valide (`POST /api/users/:id/validate-agent`, effet immédiat). Le dépassement du plafond écrit une ligne d'audit `security.bulk_access` (une par minute au plus) : copier la base devient lent, bruyant et visible. Réglages : `AGENT_VALIDATION=off` désactive la distinction ; `ALLOW_AGENT_SELF_SIGNUP=false` refuse l'inscription en agent (403 `agent_signup_disabled`).

> **Après une mise à jour :** les agents déjà présents en base ont presque toujours `assigned_by` vide : ils sont **non validés** jusqu'à ce qu'un administrateur les valide. Pour valider d'un coup tous les agents existants, par exemple l'équipe de démonstration : `UPDATE role_user ru JOIN roles r ON r.id = ru.role_id SET ru.assigned_by = <id d'un admin> WHERE r.code = 'agent' AND ru.assigned_by IS NULL;` puis attendre 30 secondes (cache des droits) ou redémarrer l'API.

### Ce que le citoyen et l'administrateur constatent

- **Le citoyen** voit ses sessions ouvertes et peut en fermer une, voit les tentatives de connexion échouées sur son compte, et voit **qui a consulté ses données** (`GET /api/auth/me/security`).
- **L'administrateur** voit les agents à valider, tout ce qui a touché un dossier (`GET /api/audit-logs?entityType=users&entityId=12`) et les attaques détectées (`GET /api/security/bots`).
- **Les journaux** ne contiennent plus d'e-mail en clair (`a***@example.com`) ni de paramètres d'adresse (une recherche peut être un nom ou un e-mail) ; les adresses IP affichées à l'utilisateur sont masquées.

### Jeton de connexion et secrets

- Les jetons sont signés en `HS256` **uniquement** (un jeton qui annonce un autre algorithme, dont `none`, est refusé).
- `JWT_ACCESS_SECRET` : 32 caractères aléatoires au minimum. Plus court, il est signalé au démarrage ; en production il est **refusé** s'il fait moins de 16 caractères ou ressemble à un exemple (`secret`, `changeme`...).
- `EXPOSE_ERRORS=true` en production est signalé au démarrage (il renvoie la cause technique des erreurs aux visiteurs).

### Limites connues

- **Un agent non validé peut encore** changer le statut des demandes, publier des annonces et gérer les rendez-vous : ce sont des actions de travail, ouvertes par le choix d'inscription libre. Elles sont tracées, mais pas restreintes. Si cela pose problème, l'étape suivante est d'exiger la validation pour publier une annonce ou clôturer une demande.
- `GET /api/auth/me/security` (`dataAccess`) ne montre que les consultations d'un dossier précis, pas les listes, et dépend du journal d'audit.
- Compteurs, blocages et plafonds sont **locaux à chaque instance** de l'API.
- Le journal d'audit contient des adresses IP (donnée personnelle) : prévoir sa durée de conservation (voir « Journal d'audit »).
- Hors périmètre de l'API : les en-têtes de la page web (CSP, anti-clickjacking) sont posés par le front (`client/next.config.ts`).
- `npm audit` signale 5 vulnérabilités dans les dépendances : 3 « élevées » viennent de l'outillage de développement (`braces`, via `nodemon`), pas du code exécuté en production ; 2 « modérées » viennent de `uuid` via `sequelize` (chemin de code non utilisé ici). Les corriger de force imposerait un changement majeur de `sequelize`.

## Protection anti-robots

Des robots envoient automatiquement des formulaires (faux comptes, spam, essais de mots de passe). La protection est **invisible pour une personne** : pas de CAPTCHA, pas de question à résoudre. Le site obtient une preuve qu'un formulaire a réellement été affiché puis rempli.

### Les quatre couches

| Couche | Ce qu'elle arrête | Ce qu'une personne voit |
|---|---|---|
| **Jeton de formulaire** signé, délivré à l'affichage, à usage unique, avec un délai minimal de remplissage | Un robot qui poste directement sur l'API (le cas de loin le plus courant) : il n'a jamais affiché le formulaire | Rien |
| **Champ piège** invisible (hors écran, ignoré par le clavier et les lecteurs d'écran) | Un robot qui remplit tous les champs qu'il trouve | Rien |
| **Rafale** : au plus 10 inscriptions par minute et par adresse (30 pour les autres formulaires) | Une fabrique de faux comptes qui obtient des jetons valides | Rien |
| **Échecs de connexion** : au plus 30 par 10 minutes et par adresse, tous comptes confondus | Le bourrage d'identifiants (un robot qui essaie des mots de passe sur de nombreux comptes) | Rien |

Chaque signal rapporte des points à l'adresse IP ; à **8 points en 10 minutes**, elle est bloquée 15 minutes (**429**). Les signaux qu'une personne peut produire sans le vouloir pèsent peu, ceux qu'un humain ne produit jamais pèsent lourd :

| Signal (`bot.<raison>` dans l'audit) | Points | Exemple |
|---|:-:|---|
| `too_fast` | 0,5 | Formulaire envoyé avant le délai minimal (le front attend et réessaie tout seul) |
| `missing_token` | 1 | Requête sans jeton (robot, ou ancien onglet resté ouvert après une mise à jour) |
| `reused_token` | 1 | Jeton déjà utilisé (double-clic sur « Envoyer ») |
| `bad_token` | 4 | Jeton falsifié ou destiné à un autre formulaire |
| `honeypot` | 4 | Champ piège rempli |
| `velocity` | blocage immédiat | Trop d'envois par minute |
| `login_failures` | blocage immédiat | Trop d'échecs de connexion |

**Blocage « souple » et « dur ».** Quand le blocage vient de signaux naturels répétés, une personne qui partage l'adresse d'un robot (mairie, Wi-Fi public) **passe quand même** si son formulaire est en règle (jeton valide). Dès qu'un signal inhumain s'y ajoute, le blocage devient « dur » : tout est refusé pour cette adresse pendant 15 minutes.

### Formulaires protégés

| Formulaire (`form`) | Route | Délai minimal |
|---|---|:-:|
| `register` | `POST /api/auth/register` | 3 s |
| `login` | `POST /api/auth/login` | 0,7 s |
| `contact` | `POST /api/contact-messages` | 3 s |
| `request` | `POST /api/requests` | 3 s |
| `appointment` | `POST /api/appointments/:id/book` | 1,5 s |
| `review` | `POST /api/services/:id/reviews` | 2,5 s |
| `comment` | `POST /api/projects/:id/comments` | 2 s |

Les formulaires d'administration et d'agent ne sont pas concernés : ils exigent déjà un compte à droits élevés.

### Protocole pour le front

1. **À l'affichage du formulaire**, demander un jeton : `GET /api/forms/token?form=register` → **200** `{ "token": "…", "minDelayMs": 3000, "expiresInMs": 7200000 }`. Public, sans état, jamais mis en cache. `form` inconnu : 400.
2. **À l'envoi**, joindre le jeton dans l'en-tête **`X-Form-Token`**. Si le formulaire contient le champ piège, joindre sa valeur dans l'en-tête **`X-Form-Hp`**, **uniquement si elle n'est pas vide** (un champ piège vide ne s'envoie pas). Le champ piège s'appelle `nickname_confirm` ; il est aussi lu dans le corps JSON sous ce nom.
3. **Un jeton ne sert qu'une fois** : après chaque envoi, réussi ou non, en redemander un.

| Réponse | Signification | Que fait le front |
|---|---|---|
| **400** `{ "code": "form_too_fast", "retryAfterMs": 2974 }` | Envoyé avant le délai minimal. **Le jeton n'est pas consommé** | Attendre `retryAfterMs` puis renvoyer **le même jeton** |
| **400** `{ "code": "form_token_invalid", "message": "…" }` | Jeton absent, falsifié, déjà utilisé ou périmé (page ouverte depuis plus de 2 h) | Demander un nouveau jeton, attendre `minDelayMs`, réessayer une fois ; sinon afficher `message` |
| **400** `{ "code": "form_check_failed", "message": "…" }` | Champ piège rempli | Afficher `message` |
| **429** `{ "code": "bot_blocked", "retryAfterSeconds": 900 }` | Adresse bloquée | **Ne pas réessayer automatiquement** ; afficher `message` |

Exemple :

```js
const { token, minDelayMs } = await (await fetch(`${API}/forms/token?form=contact`)).json();
// … la personne remplit le formulaire …
await fetch(`${API}/contact-messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, "X-Form-Token": token },
  body: JSON.stringify({ subject, message }),
});
```

### Voir ce que fait la protection

- **Journal serveur** : une ligne `[BOT]` par détection, et une à chaque blocage (au plus une par seconde, pour que le journal ne devienne pas le problème sous attaque).
- **Journal d'audit** (`GET /api/audit-logs?action=bot.honeypot`) : `bot.missing_token`, `bot.bad_token`, `bot.too_fast`, `bot.reused_token`, `bot.honeypot`, `bot.velocity`, `bot.login_failures` et `bot.blocked`, avec l'adresse IP et le formulaire. Une fois une adresse bloquée, ses tentatives suivantes ne s'écrivent plus en base : un robot qui insiste ne peut pas remplir la table (300 tentatives de plus ont produit 8 lignes).
- **Statistiques** : `GET /api/security/bots?hours=24` 🛡️ (permission `admin.users.manage`).

```json
{
  "mode": "on", "hours": 24, "totalSignals": 27, "blocks": 6,
  "byReason": { "missing_token": 16, "bad_token": 3, "honeypot": 2, "too_fast": 3, "reused_token": 1, "velocity": 1, "login_failures": 1 },
  "byForm": { "register": 23, "login": 4 },
  "topIps": [{ "ip": "198.51.100.2", "signals": 5, "lastAt": "2026-10-04T01:11:18.000Z" }],
  "recent": [{ "action": "bot.blocked", "form": "register", "ip": "198.51.100.9", "at": "2026-10-04T01:11:40.000Z" }],
  "live": { "blockedRequests": 330, "blocksIssued": 6, "blockedIpsNow": 6, "trackedIps": 8, "byReason": {}, "byForm": {} }
}
```

`live` compte depuis le démarrage de cette instance, y compris les tentatives déjà bloquées (non écrites en base).

### Mise en service

La variable **`BOT_PROTECTION`** a trois valeurs :

| Valeur | Effet |
|---|---|
| `on` (**défaut**) | Bloque : jeton obligatoire sur les formulaires protégés |
| `monitor` | Détecte, journalise, audite et alimente les statistiques, **sans rien bloquer** |
| `off` | Désactivée |

En mode `on`, un formulaire protégé sans jeton est refusé (400). Le front (`client/components/forms/form-guard.tsx`) l'envoie sur les 7 formulaires ; **un script, Postman ou un test automatisé doit joindre `X-Form-Token`** (voir « Protocole pour le front »), ou tourner avec `BOT_PROTECTION=monitor` ou `off`. `monitor` sert à mesurer avant d'activer ou à diagnostiquer un faux positif : tout formulaire sans jeton y apparaît dans les statistiques comme `missing_token`.

**Refus pour surcharge.** Un 503 (file de hachage pleine, base saturée) est émis avant toute écriture : le jeton utilisé par la requête refusée est **rendu**, et le front peut la rejouer avec le même jeton sans pénalité. Un jeton qui a réellement abouti reste consommé.

**`TRUST_PROXY` doit être réglé en production** derrière un hébergeur ou un proxy (voir « Charge et stabilité »). Sans lui, tous les habitants auraient la même adresse IP et la limite d'inscriptions les toucherait tous. La protection s'en protège : quand elle voit l'en-tête `X-Forwarded-For` alors que `TRUST_PROXY` est absent, elle **n'applique aucun blocage par adresse** (seuls restent les contrôles du jeton et du champ piège) et l'écrit une fois dans le journal. `BOT_ALLOWLIST` liste les adresses à ne jamais bloquer.

### Limites

- **Un robot sophistiqué** qui charge réellement la page, attend le délai, remplit un navigateur piloté et n'écrit pas dans le champ piège passe les deux premières couches ; il reste borné par la limite de rafale (10 inscriptions par minute par adresse) et visible dans les statistiques. Si les abus continuent, l'étape suivante est un défi supplémentaire déclenché **seulement** pour les adresses déjà suspectes (un CAPTCHA ciblé, jamais pour tout le monde).
- Comptes de blocage et jetons déjà utilisés sont **locaux à chaque instance** de l'API (comme les caches) : avec plusieurs instances, un jeton déjà utilisé sur l'une peut l'être une fois sur une autre, et une adresse bloquée sur l'une ne l'est pas sur les autres.
- Les adresses IP changent (réseau mobile) : le jeton n'y est volontairement pas lié.

## Charge et stabilité

Objectif : rester disponible quand beaucoup d'habitants se connectent en même temps, et se dégrader proprement plutôt que s'effondrer.

### Ce qui a été mesuré (et ce que ça dit)

Mesures sur un poste de développement (8 cœurs logiques, PostgreSQL local, **un seul processus** Node), 100 connexions simultanées, outil `tools/load-test.mjs`. Ce sont des ordres de grandeur, pas une garantie : refaites-les sur l'hébergement réel.

| Scénario | Débit | Latence p95 |
|---|---|---|
| `GET /api/health` | ~1 450 req/s | ~95 ms |
| `GET /api/announcements` (connecté, en cache serveur) | ~550 req/s (contre ~300 sans cache) | ~230 ms |
| `GET /api/services` (connecté) | ~350 req/s (contre ~250 sans cache) | ~430 ms |
| `GET /api/auth/me` (connecté, 3 requêtes SQL) | ~345 req/s | ~390 ms |
| `POST /api/auth/login` | **~34 connexions/s** | attente de ~3 s pour une rafale de 100 |

À retenir :
- **Les lectures ne sont pas le risque** : ~550 req/s sur un seul processus représentent des dizaines de millions de requêtes par jour.
- **Les connexions sont le point limitant**, et cette limite est **matérielle** : chaque connexion calcule un hachage `scrypt` (volontairement coûteux, ~100 ms de calcul). Le débit plafonne à environ 35 connexions/s sur 4 cœurs physiques, quels que soient les réglages. Mille habitants qui se connectent à la même seconde attendent donc une demi-minute au total. Les sessions durent 10 jours (cookie de refresh) : une rafale n'arrive qu'à l'ouverture, pas en continu.
- Pendant une rafale de 400 connexions, la lecture des annonces par d'autres habitants reste rapide (médiane ~35 ms) : le hachage ne bloque pas le reste de l'API.

### Comportement sous surcharge

| Situation | Réponse | Le client |
|---|---|---|
| Plus de `HASH_QUEUE_MAX` connexions en attente, ou attente > `HASH_QUEUE_TIMEOUT_MS` | **503** + `Retry-After: 3` + `{ message, retryAfterSeconds }`, avant tout traitement | Réessaie tout seul |
| Pool de connexions PostgreSQL épuisé, base injoignable, trop de connexions | **503** + `Retry-After: 3` (au lieu d'un 500 opaque) | Réessaie tout seul |
| Limitation de débit dépassée (si activée) | **429** + `Retry-After` | Réessaie après le délai |
| Corps de requête > 100 ko | 413 | |
| Requête qui dure plus de 30 s | Coupée par le serveur | |

Un refus 503 ou 429 est émis **avant** toute écriture : le rejouer ne crée jamais de doublon. Le front rejoue automatiquement les lectures, et la connexion/l'inscription sur 503/429 (`client/lib/network.ts`).

### Ce qui est en place côté API

- **Hachage des mots de passe** (`utils/password.ts`) : au plus `HASH_CONCURRENCY` calculs simultanés, les autres font la queue (FIFO, bornée). Le thread pool de Node est agrandi (`UV_THREADPOOL_SIZE`) pour que le DNS, la compression et le disque ne soient jamais bloqués par une rafale de connexions.
- **Cache serveur des listes communes à tous** (`utils/responseCache.ts`) : catalogue des services, moyennes d'avis, annonces publiées, plus `/api/public/*`. Une seule requête SQL sert tous les habitants ; les requêtes simultanées sur une donnée expirée sont **coalescées** (une seule requête SQL, pas cent). Toute création, modification ou suppression **invalide immédiatement** le cache concerné ; le TTL (15-30 s) n'est qu'un filet de sécurité. Les données propres à un utilisateur (`reviewedByMe`, ses demandes) ne sont **jamais** mises en cache.
- **Cache navigateur** : `GET /api/announcements` renvoie `Cache-Control: private, max-age=15, stale-while-revalidate=60` aux citoyens (jamais aux gestionnaires, qui doivent voir leurs modifications tout de suite). Conséquence : un citoyen peut voir une annonce publiée jusqu'à ~15 s après sa publication.
- **Compression** gzip des réponses (utile sur connexion lente), **corps JSON limité à 100 ko**, connexions persistantes et délais de requête réglés pour les proxys.
- **Audit asynchrone** (`utils/auditQueue.ts`) : les lignes d'audit sont insérées en lot toutes les secondes, jamais avant la réponse. Son coût mesuré est inférieur à 5 %.
- **Journal des requêtes** (`LOG_REQUESTS`) : en production, seuls les statuts ≥ 400 et les requêtes lentes sont journalisés. Tout journaliser coûte ~20 % de débit.
- **Arrêt propre** : à `SIGINT`/`SIGTERM` le serveur finit les requêtes en cours et vide la file d'audit.

### Réglages recommandés en production

| Variable | Valeur conseillée |
|---|---|
| `UV_THREADPOOL_SIZE` | `16`, à poser dans l'environnement du processus (déjà fait par `nodemon.json` en développement) |
| `TRUST_PROXY` | Nombre de proxys devant l'API (ex. `1`). **À régler avant d'activer les limites** : sinon tous les habitants partagent l'IP du proxy |
| `REALTIME_MAX_CONNECTIONS_PER_IP` | Connexions temps réel (socket.io) par adresse, défaut `50` (adresses partagées : box, école, réseau mobile). Un onglet = une connexion. Sans `TRUST_PROXY` derrière un proxy, ce plafond est désactivé |
| `REALTIME_MAX_CONNECTIONS` | Plafond global de connexions temps réel, défaut `5000` |
| `OPEN_CODE_API_KEY` (ou `OPENCODE_API_KEY`) | Clé de la passerelle IA OpenCode Zen : orientation des habitants et brouillons d'alerte. Sans clé, les deux fonctionnent en mode sans IA (mots-clés, modèles de texte) |
| `LLM_BASE_URL`, `LLM_MODEL` | Passerelle (défaut `https://opencode.ai/zen/v1`) et modèle (défaut `space-bunny-free`) |
| `ALERT_AI_TIMEOUT_MS` | Délai laissé à l'IA pour un brouillon d'alerte, défaut `20000` |
| `AI_DRAFT_RATE_LIMIT_PER_MINUTE` | Brouillons d'alerte par minute et par compte, défaut `10` (`0` : désactivé) |
| `TRANSPORT_TIMEZONE` | Fuseau horaire des horaires de transport (ex. `Indian/Antananarivo`), défaut : celui du serveur |
| `SNAPSHOT_DIR` | Dossier des copies de secours des informations publiques, défaut `data/snapshots` (ignoré par git) |
| `DB_READ_TIMEOUT_MS` | Au-delà, une lecture publique est servie depuis sa copie de secours, défaut `3000` |
| `PLATFORM_NOTICE_FILE` | Fichier de l'avis d'incident, défaut `data/platform-notice.json` (lisible même base en panne, modifiable à la main) |
| `EMERGENCY_NUMBER` | Numéro d'urgence vitale affiché partout (page de secours, kit, consignes), défaut `112` |
| `RATE_LIMIT_PER_MINUTE` | ex. `600` par adresse IP. Laissez large : plusieurs habitants peuvent partager une même IP (Wi-Fi public, mairie) |
| `LOGIN_RATE_LIMIT_PER_15MIN` | ex. `60`. Chaque tentative de connexion coûte ~100 ms de calcul : c'est la protection contre l'abus de ce coût |
| `DB_POOL_MAX` | `10` à `20`, en gardant `max_connections` de PostgreSQL > (instances × `DB_POOL_MAX`) |
| `LOG_REQUESTS` | `errors` (déjà le défaut quand `NODE_ENV=production`) |

Pour aller plus loin que ce qu'un seul processus supporte : lancer plusieurs instances derrière le proxy. Les caches et compteurs sont **locaux à chaque instance** (la limitation de débit est donc multipliée par leur nombre, et l'invalidation d'un cache ne se propage pas : seul le TTL de 15-30 s garantit la fraîcheur entre instances).

### Mesurer soi-même

```bash
npm run dev                                                  # ou : node dist/index.js
node tools/load-test.mjs 5000 announcements 4 25 1000       # 100 connexions simultanées
node tools/load-test.mjs 5000 login 4 25 100                # rafale de connexions
```

Le test crée le compte `load_user@example.com` : supprimez-le ensuite, et ne le lancez jamais sur la production.

## Structure du projet

```
src/
├─ models/       user · authToken · auditLog · role · permission · rbac (pivots role_user, role_permission)
│                municipalService · announcement · contactMessage
├─ views/        user · role · permission · auditLog · municipalService · announcement · contactMessage   (forme JSON renvoyée au client)
├─ controllers/  auth · user · role · permission · auditLog · municipalService · announcement · contactMessage
├─ routes/       auth · user · role · permission · auditLog · municipalService · announcement · contactMessage
├─ middlewares/  auth (authenticate, requirePermission) · audit · error · requestLogger
├─ seeds/        rbac · services · index (données de base lancées au démarrage)
├─ utils/        token · password · mask · staffAccess · accessCache · responseCache · overload · formToken · botSignals · audit · auditQueue · http · logger · describeError
└─ config/       database · auth
sql/             03_metier_services_annonces.sql
```
