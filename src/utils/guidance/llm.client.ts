import type { MunicipalServiceData } from "../../models/municipalService.model";
import { MAX_GUIDANCE_STEPS } from "../../models/guidanceRequest.model";
import { aiApiKey } from "../ai/llm";
import { logger } from "../logger";

// Fournisseur unique : passerelle OpenAI-compatible, choisie par variable d'environnement.
// Les modèles gratuits y sont éphémères ("available for a limited time"), le modèle ne doit donc
// jamais être nommé en dur : il est configurable et la réponse est validée avant d'être servie.
const BASE_URL = (process.env.LLM_BASE_URL ?? "https://opencode.ai/zen/v1").replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL ?? "space-bunny-free";

// Un modèle gratuit peut être lent sans être cassé. Au-delà de ce délai on abandonne et le routage
// par mots-clés prend le relais : l'habitant attend une orientation, pas un spinner.
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 8000;
const MAX_OUTPUT_TOKENS = 400;

export interface GuidanceAnswer {
  serviceCode: string | null;
  summary: string | null;
  steps: string[];
}

/** Le modèle est-il configuré ? Sans clé, l'orientation passe directement par les mots-clés. */
export function isLlmConfigured(): boolean {
  return Boolean(aiApiKey());
}

export function llmModelName(): string {
  return MODEL;
}

// Le catalogue des services est la seule chose que le modèle doit connaître : il ne doit rien
// inventer sur la ville, il doit choisir un code existant et le commenter.
function buildSystemPrompt(services: MunicipalServiceData[]): string {
  const catalogue = services
    .map((service) => `- ${service.code} : ${service.name} — ${service.description ?? ""}`.trimEnd())
    .join("\n");

  return `Tu es l'agent d'orientation d'une ville coloniale appelée Terra Nova.
Un habitant décrit un problème en français courant, sans jargon administratif. Ton rôle : dire quel service municipal est compétent, et indiquer la démarche à suivre.

Services disponibles :
${catalogue}

Réponds UNIQUEMENT par un objet JSON, sans texte avant ni après, sans bloc de code :
{"serviceCode":"<un code exactement pris dans la liste, ou null>","summary":"<une phrase, français administratif clair, 200 caractères max>","steps":["<étape 1>","<étape 2>"]}

Règles :
- serviceCode : le code du service le plus compétent. null si aucun ne convient vraiment.
- summary : reformule le problème de l'habitant en une phrase neutre, sans le juger.
- steps : 2 à ${MAX_GUIDANCE_STEPS} étapes concrètes, à l'infinitif, une action par étape, sans ponctuation finale.
- Aucun service ne convient : serviceCode null et steps vide.`;
}

// Les modèles gratuits respectent rarement un schéma JSON demandé en toutes lettres : on tolère
// les fences et le texte autour, mais rien de plus.
function extractJson(content: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const candidate = (fenced?.[1] ?? content).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Un service-code hors catalogue est ramené à null plutôt que rejeté : le fallback par mots-clés
// fera de nouveau le travail, et une réponse fausse est pire qu'une réponse honnête.
function readAnswer(content: string, services: MunicipalServiceData[]): GuidanceAnswer | null {
  const parsed = extractJson(content);
  if (!parsed || typeof parsed !== "object") return null;

  const { serviceCode, summary, steps } = parsed as Record<string, unknown>;
  const known = services.some((service) => service.code === serviceCode);
  return {
    serviceCode: typeof serviceCode === "string" && known ? serviceCode : null,
    summary: typeof summary === "string" && summary.trim() ? summary.trim().slice(0, 300) : null,
    steps: Array.isArray(steps)
      ? steps
          .filter((step): step is string => typeof step === "string" && step.trim().length > 0)
          .map((step) => step.trim().slice(0, 200))
          .slice(0, MAX_GUIDANCE_STEPS)
      : [],
  };
}

/**
 * Demande une orientation au modèle. Rend null si le modèle est absent, en erreur, trop lent ou
 * si sa réponse n'est pas exploitable : l'appelant bascule alors sur le routage par mots-clés.
 */
export async function askModelForGuidance(
  problem: string,
  services: MunicipalServiceData[]
): Promise<GuidanceAnswer | null> {
  const apiKey = aiApiKey();
  if (!apiKey) return null;

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: buildSystemPrompt(services) },
          { role: "user", content: problem },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn("GUIDANCE", `Modèle indisponible (HTTP ${response.status}) : repli par mots-clés`);
      return null;
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    const answer = typeof content === "string" ? readAnswer(content, services) : null;
    if (!answer) logger.warn("GUIDANCE", "Réponse du modèle inexploitable : repli par mots-clés");
    return answer;
  } catch (error) {
    // Un réseau coupé ou un délai dépassé ne doit pas se traduire par une erreur 500 : c'est
    // précisément le cas que le repli par mots-clés couvre.
    logger.warn("GUIDANCE", `Appel au modèle impossible (${(error as Error).message}) : repli par mots-clés`);
    return null;
  }
}