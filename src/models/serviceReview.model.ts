import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model, QueryTypes } from "sequelize";
import sequelize from "../config/database";
import { CitizenRequest } from "./citizenRequest.model";
import { User } from "./user.model";

// ── Table service_reviews ────────────────────────────────────
// Un avis par couple (service, citoyen) : clé unique en base, vérifiée aussi par le contrôleur.
export class ServiceReview extends Model<InferAttributes<ServiceReview>, InferCreationAttributes<ServiceReview>> {
  declare id: CreationOptional<number>;
  declare serviceId: number;
  declare userId: number;
  declare rating: number;
  declare comment: string;
  declare createdAt: CreationOptional<Date>;
}

ServiceReview.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    serviceId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    rating: { type: DataTypes.SMALLINT, allowNull: false },
    comment: { type: DataTypes.TEXT, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "service_reviews", underscored: true, updatedAt: false }
);

ServiceReview.belongsTo(User, { foreignKey: "userId", as: "author" });

export type ServiceReviewData = InferAttributes<ServiceReview> & {
  author?: { id: number; firstName: string; lastName: string } | null;
};

export interface ServiceReviewStats {
  reviewsCount: number;
  averageRating: number | null;
}

// ── Accès aux données ────────────────────────────────────────
export const ServiceReviewModel = {
  async list(serviceId: number, options: { limit: number; offset: number }) {
    const { rows, count } = await ServiceReview.findAndCountAll({
      where: { serviceId },
      include: [{ model: User, as: "author", attributes: ["id", "firstName", "lastName"] }],
      order: [["createdAt", "DESC"], ["id", "DESC"]],
      limit: options.limit,
      offset: options.offset,
    });
    return { reviews: rows.map((row) => row.get({ plain: true }) as ServiceReviewData), total: count };
  },

  async findByUser(serviceId: number, userId: number) {
    return ServiceReview.findOne({ where: { serviceId, userId } });
  },

  // Avis déposés par un citoyen, tous services confondus
  async listByUser(userId: number) {
    const rows = await ServiceReview.findAll({ where: { userId }, order: [["createdAt", "DESC"]] });
    return rows.map((row) => row.get({ plain: true }) as ServiceReviewData);
  },

  async create(data: { serviceId: number; userId: number; rating: number; comment: string }) {
    return (await ServiceReview.create(data)).get({ plain: true }) as ServiceReviewData;
  },

  // Nombre d'avis et moyenne de chaque service, en une seule requête pour toute la liste
  async statsForServices(serviceIds: number[]): Promise<Map<number, ServiceReviewStats>> {
    const stats = new Map<number, ServiceReviewStats>();
    if (serviceIds.length === 0) return stats;
    const rows = await sequelize.query<{ service_id: number; total: number; average: string }>(
      `SELECT service_id, COUNT(*) AS total, AVG(rating) AS average
       FROM service_reviews WHERE service_id IN (:serviceIds) GROUP BY service_id`,
      { replacements: { serviceIds }, type: QueryTypes.SELECT }
    );
    for (const row of rows) {
      stats.set(Number(row.service_id), {
        reviewsCount: Number(row.total),
        averageRating: Math.round(Number(row.average) * 10) / 10,
      });
    }
    return stats;
  },

  // Un citoyen ne juge que les services dont une de ses demandes a été traitée (acceptée)
  async hasResolvedRequest(serviceId: number, userId: number): Promise<boolean> {
    return (await CitizenRequest.count({ where: { serviceId, userId, status: "resolved" } })) > 0;
  },
};
