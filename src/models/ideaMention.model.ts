import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model, ModelStatic, Op } from "sequelize";
import sequelize from "../config/database";
import { Announcement } from "./announcement.model";
import { Appointment } from "./appointment.model";
import { CitizenRequest } from "./citizenRequest.model";
import { Establishment } from "./establishment.model";
import { MunicipalService } from "./municipalService.model";
import { Project } from "./project.model";

// Types d'objets qu'une idée peut référencer. L'ordre est celui du menu de suggestions côté front.
export const MENTION_TARGETS = ["request", "service", "appointment", "establishment", "project", "announcement"] as const;
export type MentionTarget = (typeof MENTION_TARGETS)[number];

// Nombre d'objets référencés par idée : une idée reste une phrase, pas un annuaire
export const MAX_MENTIONS_PER_IDEA = 5;
const MAX_SUGGESTIONS_PER_TARGET = 5;

export interface MentionRef {
  type: MentionTarget;
  id: number;
}

export interface MentionSuggestion extends MentionRef {
  label: string;
}

// Permission de lecture exigée pour suggérer chaque type : un habitant ne doit jamais
// voir un objet qu'il n'a pas le droit de consulter.
export const MENTION_PERMISSIONS: Record<MentionTarget, string> = {
  request: "citizen.requests.view",
  service: "citizen.services.view",
  appointment: "citizen.appointments.view",
  establishment: "citizen.establishments.view",
  project: "citizen.projects.view",
  announcement: "citizen.announcements.view",
};

// ── Table idea_mentions ──────────────────────────────────────
// Pas de clé étrangère vers les 6 tables cibles : le pointeur est (target_type, target_id) et
// chaque type est résolu par son modèle métier. La FK porte sur l'idée, qui les porte toutes.
export class IdeaMention extends Model<InferAttributes<IdeaMention>, InferCreationAttributes<IdeaMention>> {
  declare id: CreationOptional<number>;
  declare ideaId: number;
  declare targetType: MentionTarget;
  declare targetId: number;
}

IdeaMention.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    ideaId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    targetType: { type: DataTypes.ENUM(...MENTION_TARGETS), allowNull: false },
    targetId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  },
  { sequelize, tableName: "idea_mentions", underscored: true, timestamps: false }
);

export type IdeaMentionData = InferAttributes<IdeaMention>;

// Les six tables sont interrogeées de la même façon (colonnes texte + id) : un type commun
// évite de cumuler six surcharges de `findAll` sans information.
const TARGET_MODELS: Record<MentionTarget, ModelStatic<Model>> = {
  request: CitizenRequest,
  service: MunicipalService,
  appointment: Appointment,
  establishment: Establishment,
  project: Project,
  announcement: Announcement,
};

// Colonne de texte et libellé affichable de chaque type
const LABEL_SPEC: Record<MentionTarget, { text: string; label: (row: Record<string, unknown>) => string }> = {
  request: { text: "subject", label: (row) => String(row.subject) },
  service: { text: "name", label: (row) => String(row.name) },
  // Un rendez-vous n'a pas toujours de sujet : on retombe alors sur son numéro
  appointment: { text: "subject", label: (row) => String(row.subject ?? `#${row.id}`) },
  establishment: { text: "name", label: (row) => String(row.name) },
  project: { text: "title", label: (row) => String(row.title) },
  announcement: { text: "title", label: (row) => String(row.title) },
};

// Conditions d'accès à un objet, indépendantes de la recherche : une mention est validée
// sur ces critères, jamais sur le texte recherché.
function visibilityScope(type: MentionTarget, userId: number): Record<string | symbol, unknown> {
  switch (type) {
    case "request":
      return { userId };
    case "appointment":
      return { citizenId: userId };
    case "announcement":
      // Une annonce non publiée n'est pas un objet public : elle n'est ni listable ni mentionnable
      return { status: "published" };
    case "service":
    case "establishment":
      return { isActive: true };
    default:
      return {};
  }
}

// ── Accès aux données ────────────────────────────────────────
export const IdeaMentionModel = {
  // Suggestions du menu contextuel. `types` est déjà filtré par les permissions du demandeur,
  // `visibilityScope` re-vérifie que chaque objet est bien visible par cet habitant.
  async searchSuggestions(types: MentionTarget[], query: string, userId: number): Promise<MentionSuggestion[]> {
    const like = { [Op.iLike]: `%${query.trim()}%` };
    const results = await Promise.all(
      types.map(async (type) => {
        const { text, label } = LABEL_SPEC[type];
        const rows = (await TARGET_MODELS[type].findAll({
          where: { ...visibilityScope(type, userId), [text]: like },
          attributes: ["id", text],
          limit: MAX_SUGGESTIONS_PER_TARGET,
          raw: true,
        })) as unknown as Record<string, unknown>[];
        return rows.map((row) => ({ type, id: Number(row.id), label: label(row) }));
      })
    );
    return results.flat();
  },

  // Les cibles existantes et accessibles, dédupliquées : c'est ici que se décide ce qui est
  // réellement attaché à l'idée, le controller ne fait que compter.
  async resolveExisting(refs: MentionRef[], userId: number): Promise<MentionRef[]> {
    const unique = [...new Map(refs.map((ref) => [`${ref.type}:${ref.id}`, ref])).values()];
    const resolved = await Promise.all(
      unique.map(async ({ type, id }) => {
        const row = await TARGET_MODELS[type].findOne({
          where: { ...visibilityScope(type, userId), id },
          attributes: ["id"],
        });
        return row ? { type, id } : null;
      })
    );
    return resolved.filter((ref): ref is MentionRef => ref !== null);
  },

  async createForIdea(ideaId: number, refs: MentionRef[]): Promise<void> {
    if (refs.length === 0) return;
    await IdeaMention.bulkCreate(refs.map(({ type, id }) => ({ ideaId, targetType: type, targetId: id })));
  },

  // Mentions de plusieurs idées, libellés résolus : deux requêtes par type présent, aucun N+1
  async listForIdeas(ideaIds: number[]): Promise<Map<number, MentionSuggestion[]>> {
    const byIdea = new Map<number, MentionSuggestion[]>();
    if (ideaIds.length === 0) return byIdea;
    const rows = (await IdeaMention.findAll({ where: { ideaId: ideaIds }, order: [["id", "ASC"]] })).map(
      (row) => row.get({ plain: true }) as IdeaMentionData
    );
    const labels = await IdeaMentionModel.resolveLabels(rows);
    for (const row of rows) {
      const list = byIdea.get(row.ideaId) ?? [];
      const label = labels.get(`${row.targetType}:${row.targetId}`);
      if (label) list.push({ type: row.targetType, id: row.targetId, label });
      byIdea.set(row.ideaId, list);
    }
    return byIdea;
  },

  async resolveLabels(refs: IdeaMentionData[]): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    const idsByType = new Map<MentionTarget, Set<number>>();
    for (const ref of refs) {
      const ids = idsByType.get(ref.targetType) ?? new Set<number>();
      ids.add(ref.targetId);
      idsByType.set(ref.targetType, ids);
    }
    await Promise.all(
      [...idsByType.entries()].map(async ([type, ids]) => {
        const { text, label } = LABEL_SPEC[type];
        const rows = (await TARGET_MODELS[type].findAll({
          where: { id: [...ids] },
          attributes: ["id", text],
          raw: true,
        })) as unknown as Record<string, unknown>[];
        for (const row of rows) labels.set(`${type}:${Number(row.id)}`, label(row));
      })
    );
    return labels;
  },
};