import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  IncludeOptions,
  Model,
  NonAttribute,
  Op,
  QueryTypes,
  Transaction,
} from "sequelize";
import sequelize from "../config/database";
import { enumRankQuoted } from "../utils/sql";
import { MunicipalService } from "./municipalService.model";
import { User } from "./user.model";

export const REQUEST_STATUSES = ["pending", "in_progress", "resolved", "rejected"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

// Transitions autorisées. Table plutôt qu'une chaîne de if dans le contrôleur : un état
// terminal n'a pas de sortie, et rouvrir une demande rejetée reste possible pour l'agent.
// Le citoyen ne déclenche jamais une transition lui-même.
export const REQUEST_STATUS_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  pending: ["in_progress", "rejected"],
  in_progress: ["resolved", "rejected"],
  resolved: [],
  rejected: ["pending"],
};

// Priorité de traitement, fixée par les agents (jamais par le citoyen : sinon tout serait « urgent »).
export const REQUEST_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type RequestPriority = (typeof REQUEST_PRIORITIES)[number];

export function isRequestPriority(value: unknown): value is RequestPriority {
  return (REQUEST_PRIORITIES as readonly unknown[]).includes(value);
}

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return REQUEST_STATUS_TRANSITIONS[from].includes(to);
}

export function isRequestStatus(value: unknown): value is RequestStatus {
  return (REQUEST_STATUSES as readonly unknown[]).includes(value);
}

// ── Table request_status_history ──────────────────────────────
export class RequestStatusHistory extends Model<
  InferAttributes<RequestStatusHistory>,
  InferCreationAttributes<RequestStatusHistory>
> {
  declare id: CreationOptional<number>;
  declare requestId: number;
  declare oldStatus: CreationOptional<RequestStatus | null>;
  declare newStatus: RequestStatus;
  declare note: CreationOptional<string | null>;
  declare changedBy: CreationOptional<number | null>;
  declare changedAt: CreationOptional<Date>;
  declare author?: NonAttribute<Pick<User, "id" | "firstName" | "lastName"> | null>;
  // La demande porte est lue pour le sujet : c'est ce que la notification cite au citoyen.
  declare request?: NonAttribute<Pick<CitizenRequest, "id" | "subject">> | null;
}

RequestStatusHistory.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    requestId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    oldStatus: { type: DataTypes.ENUM(...REQUEST_STATUSES), allowNull: true },
    newStatus: { type: DataTypes.ENUM(...REQUEST_STATUSES), allowNull: false },
    note: { type: DataTypes.TEXT, allowNull: true },
    changedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    changedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "request_status_history", timestamps: false, updatedAt: false }
);

// ── Table citizen_requests ────────────────────────────────────
export class CitizenRequest extends Model<
  InferAttributes<CitizenRequest>,
  InferCreationAttributes<CitizenRequest>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare serviceId: CreationOptional<number | null>;
  declare subject: string;
  declare description: CreationOptional<string | null>;
  declare status: CreationOptional<RequestStatus>;
  declare priority: CreationOptional<RequestPriority>;
  declare assignedTo: CreationOptional<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date | null>;
  declare service?: NonAttribute<Pick<MunicipalService, "id" | "code" | "name"> | null>;
  declare assignee?: NonAttribute<Pick<User, "id" | "firstName" | "lastName"> | null>;
  declare owner?: NonAttribute<Pick<User, "id" | "firstName" | "lastName"> | null>;
}

CitizenRequest.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    serviceId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    subject: { type: DataTypes.STRING(255), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.ENUM(...REQUEST_STATUSES), allowNull: false, defaultValue: "pending" },
    priority: { type: DataTypes.ENUM(...REQUEST_PRIORITIES), allowNull: false, defaultValue: "medium" },
    assignedTo: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: "citizen_requests", underscored: true }
);

// Les colonnes retenues sont portées par les include : belongsTo ne les accepte pas,
// et l'historique a besoin de l'auteur sans le curriculum du demandeur.
CitizenRequest.belongsTo(User, { foreignKey: "userId", as: "owner" });
CitizenRequest.belongsTo(User, { foreignKey: "assignedTo", as: "assignee" });
CitizenRequest.belongsTo(MunicipalService, { foreignKey: "serviceId", as: "service" });

RequestStatusHistory.belongsTo(CitizenRequest, { foreignKey: "requestId", as: "request" });
RequestStatusHistory.belongsTo(User, { foreignKey: "changedBy", as: "author" });

export type CitizenRequestData = InferAttributes<CitizenRequest> & {
  service?: Pick<MunicipalService, "id" | "code" | "name"> | null;
  assignee?: Pick<User, "id" | "firstName" | "lastName"> | null;
  owner?: Pick<User, "id" | "firstName" | "lastName"> | null;
};

export type CitizenRequestUpdate = Partial<{
  status: RequestStatus;
  assignedTo: number | null;
}>;

export interface RequestFilters {
  statuses?: RequestStatus[];
  priorities?: RequestPriority[];
  // "priority" : les plus urgentes d'abord, puis les plus anciennes (celles qui attendent depuis le plus longtemps)
  sort?: "priority";
  assignedTo?: number | null;
  userId?: number;
  // Recherche libre sur l'objet et la description
  q?: string;
  // Bornes sur la date de dépôt, toutes deux inclusives
  createdFrom?: Date;
  createdTo?: Date;
  limit: number;
  offset: number;
}

const withRelations: IncludeOptions[] = [
  { model: MunicipalService, as: "service", attributes: ["id", "code", "name"] },
  { model: User, as: "assignee", attributes: ["id", "firstName", "lastName"] },
  { model: User, as: "owner", attributes: ["id", "firstName", "lastName"] },
];

const plain = (row: CitizenRequest | null) => (row?.get({ plain: true }) as CitizenRequestData) ?? null;

// ── Accès aux données ─────────────────────────────────────────
export const CitizenRequestModel = {
  async list(filters: RequestFilters) {
    const where: Record<string | symbol, unknown> = {};
    if (filters.statuses?.length) where.status = { [Op.in]: filters.statuses };
    if (filters.priorities?.length) where.priority = { [Op.in]: filters.priorities };
    if (filters.userId !== undefined) where.userId = filters.userId;
    // assignedTo = null doit signifier « non assigné », pas « ne pas filtrer »
    if (filters.assignedTo === null) where.assignedTo = null;
    else if (filters.assignedTo !== undefined) where.assignedTo = filters.assignedTo;
    if (filters.q) {
      where[Op.or] = [
        { subject: { [Op.iLike]: `%${filters.q}%` } },
        { description: { [Op.iLike]: `%${filters.q}%` } },
      ];
    }
    if (filters.createdFrom || filters.createdTo) {
      where.createdAt = {
        ...(filters.createdFrom ? { [Op.gte]: filters.createdFrom } : {}),
        ...(filters.createdTo ? { [Op.lte]: filters.createdTo } : {}),
      };
    }

    const { rows, count } = await CitizenRequest.findAndCountAll({
      where,
      include: [...withRelations],
      order:
        filters.sort === "priority"
          ? [
              [sequelize.literal(enumRankQuoted('"CitizenRequest"."priority"', ["urgent", "high", "medium", "low"])), "ASC"],
              ["createdAt", "ASC"],
              ["id", "ASC"],
            ]
          : [
              ["createdAt", "DESC"],
              ["id", "DESC"],
            ],
      limit: filters.limit,
      offset: filters.offset,
      distinct: true,
    });
    return { requests: rows.map((row) => row.get({ plain: true }) as CitizenRequestData), total: count };
  },

  // Candidats pour le repérage de demandes similaires : même service (ou, pour serviceId=null,
  // les autres demandes sans service — un groupe comme un autre), les plus récents.
  // Volume borné (300) pour que le calcul de similarité reste bon marché à chaque liste.
  async listCandidatesByService(
    serviceId: number | null,
    options: { excludeId?: number; limit?: number } = {}
  ): Promise<CitizenRequestData[]> {
    const where: Record<string | symbol, unknown> = { serviceId };
    if (options.excludeId !== undefined) where.id = { [Op.ne]: options.excludeId };
    const rows = await CitizenRequest.findAll({
      where,
      include: [{ model: User, as: "owner", attributes: ["id", "firstName", "lastName"] }],
      order: [["createdAt", "DESC"]],
      limit: options.limit ?? 300,
    });
    return rows.map((row) => row.get({ plain: true }) as CitizenRequestData);
  },

  // La transaction doit être propagée : findById ouvre une autre connexion, qui ne voit
  // ni la ligne insérée ni l'update tant que le commit n'a pas eu lieu.
  async findById(id: number, transaction?: Transaction): Promise<CitizenRequestData | null> {
    return plain(await CitizenRequest.findByPk(id, { include: [...withRelations], transaction }));
  },

  // Le propriétaire est un critère de recherche, pas une vérification faite après coup :
  // un identifiant deviné par un citoyen renvoie null, pas la demande d'autrui.
  async findOwnedById(id: number, userId: number): Promise<CitizenRequestData | null> {
    return plain(await CitizenRequest.findOne({ where: { id, userId }, include: [...withRelations] }));
  },

  // Dépôt d'une demande : la première ligne d'historique porte le statut initial
  async create(data: {
    userId: number;
    serviceId: number | null;
    subject: string;
    description: string | null;
  }): Promise<CitizenRequestData> {
    return sequelize.transaction(async (transaction) => {
      const created = await CitizenRequest.create(
        { ...data, status: "pending", assignedTo: null },
        { transaction }
      );
      await RequestStatusHistory.create(
        {
          requestId: created.id,
          oldStatus: null,
          newStatus: "pending",
          note: null,
          changedBy: data.userId,
        },
        { transaction }
      );
      // La ligne vient d'être insérée dans cette transaction : elle existe.
      return (await CitizenRequestModel.findById(created.id, transaction))!;
    });
  },

  // Une transition écrit la demande et son historique dans la même transaction : jamais
  // de demande déplacée sans trace, ni de trace sans demande.
  async transition(
    id: number,
    update: { status: RequestStatus; assignedTo?: number | null; priority?: RequestPriority },
    changedBy: number,
    note: string | null
  ): Promise<CitizenRequestData | null> {
    return sequelize.transaction(async (transaction) => {
      const request = await CitizenRequest.findByPk(id, { transaction });
      if (!request) return null;

      const previous = request.status;
      await request.update(
        {
          status: update.status,
          ...(update.assignedTo !== undefined ? { assignedTo: update.assignedTo } : {}),
          ...(update.priority !== undefined ? { priority: update.priority } : {}),
        },
        { transaction }
      );
      await RequestStatusHistory.create(
        { requestId: id, oldStatus: previous, newStatus: update.status, note, changedBy },
        { transaction }
      );
      return CitizenRequestModel.findById(id, transaction);
    });
  },

  // Le classement n'est pas un changement d'état : pas de ligne dans l'historique des statuts
  // (la trace est dans le journal d'audit).
  async setPriority(id: number, priority: RequestPriority): Promise<CitizenRequestData | null> {
    const [count] = await CitizenRequest.update({ priority }, { where: { id } });
    return count > 0 ? CitizenRequestModel.findById(id) : null;
  },

  async delete(id: number): Promise<boolean> {
    return (await CitizenRequest.destroy({ where: { id } })) > 0;
  },

  // Nombre de demandes par service, une seule requête quelle que soit la taille du catalogue
  // (même forme que ServiceReviewModel.statsForServices).
  async usageCounts(serviceIds: number[]): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    if (serviceIds.length === 0) return counts;
    const rows = await sequelize.query<{ service_id: number; total: number }>(
      `SELECT service_id, COUNT(*) AS total
       FROM citizen_requests WHERE service_id IN (:serviceIds) GROUP BY service_id`,
      { replacements: { serviceIds }, type: QueryTypes.SELECT }
    );
    for (const row of rows) counts.set(Number(row.service_id), Number(row.total));
    return counts;
  },

  // « Les habitants qui ont sollicité ce service ont aussi sollicité... » : nombre d'habitants distincts communs
  async coUsage(serviceId: number, limit: number): Promise<{ serviceId: number; people: number }[]> {
    const rows = await sequelize.query<{ service_id: number; people: number }>(
      `SELECT other.service_id, COUNT(DISTINCT other.user_id) AS people
       FROM citizen_requests mine
       JOIN citizen_requests other ON other.user_id = mine.user_id AND other.service_id <> mine.service_id
       WHERE mine.service_id = :serviceId AND other.service_id IS NOT NULL
       GROUP BY other.service_id
       ORDER BY people DESC
       LIMIT :limit`,
      { replacements: { serviceId, limit }, type: QueryTypes.SELECT }
    );
    return rows.map((row) => ({ serviceId: Number(row.service_id), people: Number(row.people) }));
  },
};

export const RequestHistoryModel = {
  async listByRequest(requestId: number) {
    const rows = await RequestStatusHistory.findAll({
      where: { requestId },
      include: [{ model: User, as: "author", attributes: ["id", "firstName", "lastName"] }],
      order: [
        ["changedAt", "ASC"],
        ["id", "ASC"],
      ],
    });
    return rows.map((row) => row.get({ plain: true }));
  },
};