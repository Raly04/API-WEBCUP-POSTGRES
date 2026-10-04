import { logger } from "../logger";

// Accès commun au modèle de langage (passerelle OpenAI-compatible OpenCode Zen). La clé est acceptée sous ses deux
// orthographes : OPENCODE_API_KEY (historique) ou OPEN_CODE_API_KEY.
const BASE_URL = (process.env.LLM_BASE_URL ?? "https://opencode.ai/zen/v1").replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL ?? "space-bunny-free";

export function aiApiKey(): string | undefined {
  return process.env.OPENCODE_API_KEY || process.env.OPEN_CODE_API_KEY || undefined;
}

export function aiModelName(): string {
  return MODEL;
}

// Les modèles gratuits respectent mal un schéma JSON demandé en toutes lettres : on tolère un bloc de code et du
// texte autour, rien de plus.
export function extractJsonObject(content: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const candidate = (fenced?.[1] ?? content).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Demande une réponse JSON au modèle. Rend null s'il n'est pas configuré, en erreur, trop lent ou si la réponse n'est
 * pas un objet JSON : l'appelant a TOUJOURS une solution de repli, l'IA n'est jamais un point de défaillance.
 */
export async function askJson(
  scope: string,
  system: string,
  user: string,
  options: { maxTokens?: number; timeoutMs?: number } = {}
): Promise<Record<string, unknown> | null> {
  const apiKey = aiApiKey();
  if (!apiKey) return null;
  const started = Date.now();
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: options.maxTokens ?? 600,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? (Number(process.env.LLM_TIMEOUT_MS) || 12_000)),
    });
    if (!response.ok) {
      logger.warn(scope, `Modèle indisponible (HTTP ${response.status}) : repli`);
      return null;
    }
    const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = payload.choices?.[0]?.message?.content;
    const json = typeof content === "string" ? extractJsonObject(content) : null;
    if (!json) logger.warn(scope, "Réponse du modèle inexploitable : repli");
    else logger.info(scope, `Réponse du modèle en ${Date.now() - started} ms`);
    return json;
  } catch (error) {
    logger.warn(scope, `Appel au modèle impossible (${(error as Error).message}) : repli`);
    return null;
  }
}

// Avant tout envoi à un service externe : on retire adresses e-mail et numéros de téléphone qu'un texte libre pourrait
// contenir. Le modèle n'en a jamais besoin pour rédiger.
export function redactPersonalData(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[e-mail retiré]")
    .replace(/\+?\d[\d .()-]{6,}\d/g, "[numéro retiré]");
}
