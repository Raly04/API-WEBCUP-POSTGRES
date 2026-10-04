import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Op,
  Transaction,
} from "sequelize";
import sequelize from "../config/database";

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<number>;
  declare email: string;
  declare passwordHash: string;
  declare firstName: string;
  declare lastName: string;
  declare phone: CreationOptional<string | null>;
  declare address: CreationOptional<string | null>;
  declare isActive: CreationOptional<boolean>;
  declare lastLoginAt: CreationOptional<Date | null>;
  // Secret TOTP chiffré (utils/crypto.ts) : présent dès qu'une configuration est en cours, mais la
  // double authentification ne protège la connexion qu'une fois twoFactorEnabled=true (voir
  // accountSecurity.controller.twoFactorVerify). Un secret en attente jamais vérifié est écrasé sans
  // conséquence par une nouvelle tentative de configuration.
  declare twoFactorEnabled: CreationOptional<boolean>;
  declare twoFactorSecret: CreationOptional<string | null>;
  // Tableau JSON de hachages (utils/password.ts), un par code de secours encore valable
  declare twoFactorRecoveryCodes: CreationOptional<string | null>;
  // Dernier pas TOTP accepté : empêche de rejouer un code déjà utilisé (voir utils/totp.ts)
  declare twoFactorLastCounter: CreationOptional<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

User.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false },
    firstName: { type: DataTypes.STRING(100), allowNull: false },
    lastName: { type: DataTypes.STRING(100), allowNull: false },
    phone: { type: DataTypes.STRING(30), allowNull: true },
    address: { type: DataTypes.STRING(255), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true },
    twoFactorEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    twoFactorSecret: { type: DataTypes.STRING(255), allowNull: true },
    twoFactorRecoveryCodes: { type: DataTypes.TEXT, allowNull: true },
    twoFactorLastCounter: { type: DataTypes.BIGINT, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "users" }
);

export type PublicUser = Omit<
  InferAttributes<User>,
  "passwordHash" | "twoFactorSecret" | "twoFactorRecoveryCodes" | "twoFactorLastCounter"
>;
export type UserUpdate = Partial<
  Pick<InferAttributes<User>, "email" | "passwordHash" | "firstName" | "lastName" | "phone" | "address" | "isActive">
>;

function toPublic(user: User): PublicUser {
  const { passwordHash: _passwordHash, twoFactorSecret: _s, twoFactorRecoveryCodes: _r, twoFactorLastCounter: _c, ...publicUser } =
    user.get({ plain: true });
  return publicUser;
}

export const UserModel = {
  async findByEmail(email: string) {
    const user = await User.findOne({ where: { email } });
    return user?.get({ plain: true }) ?? null;
  },

  // Avec le hash : réservé à la vérification du mot de passe
  async findById(id: number) {
    const user = await User.findByPk(id);
    return user?.get({ plain: true }) ?? null;
  },

  async findPublicById(id: number): Promise<PublicUser | null> {
    const user = await User.findByPk(id);
    return user ? toPublic(user) : null;
  },

  async create(
    data: { email: string; passwordHash: string; firstName: string; lastName: string; phone?: string; address?: string },
    transaction?: Transaction
  ): Promise<PublicUser> {
    return toPublic(await User.create(data, { transaction }));
  },

  async update(id: number, data: UserUpdate): Promise<PublicUser | null> {
    const user = await User.findByPk(id);
    return user ? toPublic(await user.update(data)) : null;
  },

  // Suppression définitive : les tables liées dont la clé étrangère est en CASCADE suivent,
  // celles en SET NULL perdent le lien. Les tables sans clé étrangère (auth_tokens, role_user)
  // sont purgées explicitement par le contrôleur avant cet appel.
  async remove(id: number, transaction?: Transaction): Promise<boolean> {
    return (await User.destroy({ where: { id }, transaction })) > 0;
  },

  touchLogin(id: number) {
    return User.update({ lastLoginAt: new Date() }, { where: { id } });
  },

  // Secret en attente de vérification : twoFactorEnabled reste false tant que twoFactorVerify
  // (accountSecurity.controller) n'a pas prouvé que le citoyen l'a bien enregistré dans son
  // application d'authentification. Écrase sans risque une configuration précédente abandonnée.
  setPendingTwoFactorSecret(id: number, encryptedSecret: string) {
    return User.update(
      { twoFactorSecret: encryptedSecret, twoFactorEnabled: false, twoFactorRecoveryCodes: null, twoFactorLastCounter: null },
      { where: { id } }
    );
  },

  enableTwoFactor(id: number, recoveryCodesHash: string, counter: number) {
    return User.update(
      { twoFactorEnabled: true, twoFactorRecoveryCodes: recoveryCodesHash, twoFactorLastCounter: counter },
      { where: { id } }
    );
  },

  disableTwoFactor(id: number) {
    return User.update(
      { twoFactorEnabled: false, twoFactorSecret: null, twoFactorRecoveryCodes: null, twoFactorLastCounter: null },
      { where: { id } }
    );
  },

  updateTwoFactorState(id: number, data: { lastCounter?: number; recoveryCodes?: string | null }) {
    const update: Partial<InferAttributes<User>> = {};
    if (data.lastCounter !== undefined) update.twoFactorLastCounter = data.lastCounter;
    if (data.recoveryCodes !== undefined) update.twoFactorRecoveryCodes = data.recoveryCodes;
    return User.update(update, { where: { id } });
  },

  async isActive(id: number) {
    const user = await User.findByPk(id, { attributes: ["id", "isActive"] });
    return user?.isActive === true;
  },

  async list({
    search,
    limit,
    offset,
    roleCode,
  }: {
    search?: string;
    limit: number;
    offset: number;
    // Restreint aux utilisateurs portant exactement ce rôle (et aucun autre) : voir UserModel.hasOnlyRole
    roleCode?: string;
  }) {
    const conditions = [];
    if (search) {
      conditions.push({
        [Op.or]: [
          { email: { [Op.iLike]: `%${search}%` } },
          { firstName: { [Op.iLike]: `%${search}%` } },
          { lastName: { [Op.iLike]: `%${search}%` } },
        ],
      });
    }
    if (roleCode) {
      conditions.push({
        id: {
          [Op.in]: sequelize.literal(
            `(SELECT ru.user_id FROM role_user ru JOIN roles r ON r.id = ru.role_id WHERE r.code = ${sequelize.escape(roleCode)})`
          ),
        },
      });
    }
    const where = conditions.length > 0 ? { [Op.and]: conditions } : {};
    const { rows, count } = await User.findAndCountAll({ where, limit, offset, order: [["id", "DESC"]] });
    return { users: rows.map(toPublic), total: count };
  },
};
