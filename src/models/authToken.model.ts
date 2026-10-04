import { CreationOptional, DataTypes, InferAttributes, InferCreationAttributes, Model, Op, Transaction } from "sequelize";
import sequelize from "../config/database";

// Un refresh token = une ligne : seul son hash SHA-256 est stocké.
export class AuthToken extends Model<InferAttributes<AuthToken>, InferCreationAttributes<AuthToken>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare tokenHash: string;
  declare userAgent: CreationOptional<string | null>;
  declare ipAddress: CreationOptional<string | null>;
  declare expiresAt: Date;
  declare lastUsedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
}

AuthToken.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    tokenHash: { type: DataTypes.STRING(255), allowNull: false, unique: true },
    userAgent: { type: DataTypes.STRING(255), allowNull: true },
    ipAddress: { type: DataTypes.STRING(45), allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    lastUsedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "auth_tokens", updatedAt: false }
);

export const AuthTokenModel = {
  create(data: { userId: number; tokenHash: string; expiresAt: Date; userAgent?: string; ipAddress?: string }) {
    return AuthToken.create({ ...data, lastUsedAt: new Date() });
  },

  async findByHash(tokenHash: string) {
    const token = await AuthToken.findOne({ where: { tokenHash } });
    return token?.get({ plain: true }) ?? null;
  },

  // Suppression atomique : renvoie false si le token a déjà été consommé (requête concurrente).
  // Sert à la rotation : chaque refresh token n'est utilisable qu'une fois.
  async consume(id: number) {
    return (await AuthToken.destroy({ where: { id } })) > 0;
  },

  deleteByHash(tokenHash: string) {
    return AuthToken.destroy({ where: { tokenHash } });
  },

  // Sessions ouvertes (non expirées) d'un utilisateur, la plus récemment utilisée d'abord
  async listActiveForUser(userId: number) {
    const rows = await AuthToken.findAll({
      where: { userId, expiresAt: { [Op.gt]: new Date() } },
      order: [["lastUsedAt", "DESC"], ["id", "DESC"]],
    });
    return rows.map((row) => row.get({ plain: true }));
  },

  // Le propriétaire fait partie de la condition : impossible de fermer la session de quelqu'un d'autre
  async deleteOwned(id: number, userId: number) {
    return (await AuthToken.destroy({ where: { id, userId } })) > 0;
  },

  // Toutes les sessions de l'utilisateur. Le transaction est indispensable lors d'une
  // suppression de compte : sans elle, un échec de la suppression laisserait un compte
  // sans session, donc inaccessible.
  deleteAllForUser(userId: number, transaction?: Transaction) {
    return AuthToken.destroy({ where: { userId }, transaction });
  },

  deleteExpiredForUser(userId: number) {
    return AuthToken.destroy({ where: { userId, expiresAt: { [Op.lt]: new Date() } } });
  },

  // Sessions ouvertes (refresh tokens non expirés) : une ligne par session. Les lignes expirées ne sont
  // purgées qu'à la connexion suivante de l'utilisateur, il faut donc les exclure du compte.
  countActiveForUser(userId: number) {
    return AuthToken.count({ where: { userId, expiresAt: { [Op.gt]: new Date() } } });
  },
};
