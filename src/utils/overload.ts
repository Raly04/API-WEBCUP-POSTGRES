// Surcharge momentanée : le serveur refuse proprement (503 + Retry-After) au lieu de laisser les requêtes
// s'empiler jusqu'à l'expiration des délais du navigateur ou du proxy. Le client peut réessayer tout seul.
export class OverloadedError extends Error {
  readonly status = 503;
  constructor(
    message = "Forte affluence : réessayez dans quelques secondes",
    readonly retryAfterSeconds = 3
  ) {
    super(message);
    this.name = "OverloadedError";
  }
}
