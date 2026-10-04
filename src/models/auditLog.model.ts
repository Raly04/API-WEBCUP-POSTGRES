import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model, Op } from "sequelize";
import sequelize from "../config/database";
import { User } from "./user.model";

export class AuditLog extends Model<InferAttributes<AuditLog>, InferCreationAttributes<AuditLog>> {
  declare id: CreationOptional<number>;
  declare userId: CreationOptional<number | null>;
  declare action: string;
  declare entityType: CreationOptional<string | null>;
  declare entityId: CreationOptional<number | null>;
  declare ipAddress: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}

AuditLog.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    action: { type: DataTypes.STRING(100), allowNull: false },
    entityType: { type: DataTypes.STRING(100), allowNull: true },
    entityId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    ipAddress: { type: DataTypes.STRING(45), allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "audit_logs", updatedAt: false }
);

export type AuditLogData = InferAttributes<AuditLog> & {
  user?: { id: number; email: string; firstName: string; lastName: string } | null;
};

// Une trace du middleware a toujours la forme "MÉTHODE /chemin statut" ; les décisions métier
// consignées par audit() dans les contrôleurs sont des codes ("request.resolved", "login").
// Cette liste est la définition serveur : le front ne doit pas la redéfinir, il lit le drapeau
// `technical` renvoyé par la vue.
export const TECHNICAL_VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export function isTechnicalAction(action: string): boolean {
  return TECHNICAL_VERBS.some((verb) => action.startsWith(`${verb} `));
}

// Auteur de l'action (jamais le hash du mot de passe)
AuditLog.belongsTo(User, { foreignKey: "userId", as: "user" });

export const AuditLogModel = {
  create(data: {
    userId?: number | null;
    action: string;
    entityType?: string;
    entityId?: number;
    ipAddress?: string;
  }) {
    return AuditLog.create(data);
  },

  async list({
    limit,
    offset,
    userId,
    action,
    entityType,
    entityId,
    technical,
  }: {
    limit: number;
    offset: number;
    userId?: number;
    action?: string;
    entityType?: string;
    entityId?: number;
    // "exclude" (défaut du journal agent) : ne garder que les décisions métier, en écartant les
    // traces de requêtes du middleware. "include" : tout renvoyer, comme le journal d'administration.
    technical?: "include" | "exclude";
  }) {
    const conditions: unknown[] = [];
    if (userId !== undefined) conditions.push({ userId });
    if (action) conditions.push({ action });
    if (entityType) conditions.push({ entityType });
    if (entityId !== undefined) conditions.push({ entityId });
    if (technical === "exclude") {
      // Un seul littéral regex plutôt qu'une boucle : `NOT LIKE` n'a pas d'équivalent
      // insensible à la casse en Sequelize (`{ [Op.not]: { [Op.iLike]: … } }` lève une
      // erreur), et `Op.regexp` génère `~`, qui EST sensible à la casse. L'opérateur `!~*`
      // de PostgreSQL est l'exact équivalent du `NOT LIKE` de MySQL sous la collation
      // utf8mb4_unicode_ci : un seul littéral, insensible à la casse, au lieu d'une boucle.
      // TECHNICAL_VERBS ne contient que des majuscules : aucun caractère spécial de regex,
      // l'interpolation dans le littéral est donc sûre.
      const pattern = `^(${TECHNICAL_VERBS.join("|")}) `;
      conditions.push(sequelize.literal(`"action" !~* '${pattern}'`));
    }
    const where = conditions.length > 0 ? { [Op.and]: conditions } : {};
    const { rows, count } = await AuditLog.findAndCountAll({
      where,
      include: [{ model: User, as: "user", attributes: ["id", "email", "firstName", "lastName"], required: false }],
      limit,
      offset,
      order: [["id", "DESC"]],
    });
    return { logs: rows.map((row) => row.get({ plain: true }) as AuditLogData), total: count };
  },
};
