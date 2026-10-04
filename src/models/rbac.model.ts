import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Op,
  QueryTypes,
  Transaction,
} from "sequelize";
import sequelize from "../config/database";
import { RoleModel } from "./role.model";

export class RoleUser extends Model<InferAttributes<RoleUser>, InferCreationAttributes<RoleUser>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare roleId: number;
  declare assignedAt: CreationOptional<Date>;
  declare assignedBy: CreationOptional<number | null>;
}

RoleUser.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    roleId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    assignedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    assignedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
  },
  { sequelize, tableName: "role_user", timestamps: false }
);

export class RolePermission extends Model<InferAttributes<RolePermission>, InferCreationAttributes<RolePermission>> {
  declare id: CreationOptional<number>;
  declare roleId: number;
  declare permissionId: number;
  declare grantedAt: CreationOptional<Date>;
}

RolePermission.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    roleId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    permissionId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    grantedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "role_permission", timestamps: false }
);

export const CITIZEN_ROLE = "citizen";

export const RbacModel = {
  async roleCodesForUser(userId: number): Promise<string[]> {
    const rows = await sequelize.query<{ code: string }>(
      `SELECT r.code FROM roles r
       JOIN role_user ru ON ru.role_id = r.id
       WHERE ru.user_id = :userId
       ORDER BY r.level DESC`,
      { replacements: { userId }, type: QueryTypes.SELECT }
    );
    return rows.map((row) => row.code);
  },

  // Rôles de plusieurs utilisateurs en une requête : { [userId]: ["citizen", ...] }
  async roleCodesForUsers(userIds: number[]): Promise<Record<number, string[]>> {
    if (userIds.length === 0) return {};
    const rows = await sequelize.query<{ user_id: number; code: string }>(
      `SELECT ru.user_id, r.code FROM role_user ru
       JOIN roles r ON r.id = ru.role_id
       WHERE ru.user_id IN (:userIds)
       ORDER BY r.level DESC`,
      { replacements: { userIds }, type: QueryTypes.SELECT }
    );
    const byUser: Record<number, string[]> = {};
    for (const row of rows) (byUser[Number(row.user_id)] ??= []).push(row.code);
    return byUser;
  },

  findRoleByCode(code: string) {
    return RoleModel.findByCode(code);
  },

  // Idempotent : renvoie false si l'utilisateur a déjà ce rôle
  async assignRole(userId: number, roleId: number, assignedBy: number | null, transaction?: Transaction) {
    const [, created] = await RoleUser.findOrCreate({
      where: { userId, roleId },
      defaults: { userId, roleId, assignedBy },
      transaction,
    });
    return created;
  },

  // Administrateur, ou agent dont le rôle a été attribué/confirmé par un administrateur (assigned_by renseigné).
  // Un agent inscrit seul a assigned_by vide : il n'est pas validé.
  async isValidatedStaff(userId: number): Promise<boolean> {
    const rows = await sequelize.query<{ code: string; assignedBy: number | null }>(
      `SELECT r.code, ru.assigned_by AS "assignedBy" FROM role_user ru
       JOIN roles r ON r.id = ru.role_id
       WHERE ru.user_id = :userId AND r.code IN ('agent', 'admin')`,
      { replacements: { userId }, type: QueryTypes.SELECT }
    );
    return rows.some((row) => row.code === "admin" || row.assignedBy !== null);
  },

  // Valide un rôle déjà porté (renseigne assigned_by). Renvoie false si le rôle n'est pas porté ou déjà validé.
  async validateRole(userId: number, roleId: number, adminId: number) {
    const [count] = await RoleUser.update({ assignedBy: adminId }, { where: { userId, roleId, assignedBy: null } });
    return count > 0;
  },

  // Agents inscrits seuls, en attente de validation
  async listPendingAgents() {
    return sequelize.query<{ id: number; email: string; firstName: string; lastName: string; createdAt: Date }>(
      `SELECT u.id, u.email, u.first_name AS "firstName", u.last_name AS "lastName", u.created_at AS "createdAt"
       FROM users u
       JOIN role_user ru ON ru.user_id = u.id AND ru.assigned_by IS NULL
       JOIN roles r ON r.id = ru.role_id AND r.code = 'agent'
       WHERE u.is_active = TRUE
       ORDER BY u.id DESC`,
      { type: QueryTypes.SELECT }
    );
  },

  async removeRole(userId: number, roleId: number) {
    return (await RoleUser.destroy({ where: { userId, roleId } })) > 0;
  },

  // Purge tous les rôles d'un utilisateur. role_user n'a pas de clé étrangère vers users
  // (table pivot sans contrainte), donc la suppression du compte ne la vide pas : sans cet
  // appel, les lignes survivraient et pourraient réattribuer des droits à un futur compte
  // réutilisant le même id.
  async removeAllRoles(userId: number, transaction?: Transaction) {
    return RoleUser.destroy({ where: { userId }, transaction });
  },

  // Ajoute des permissions à un rôle (idempotent). Renvoie le nombre de liaisons réellement créées.
  async grantPermissions(roleId: number, permissionIds: number[], transaction?: Transaction) {
    if (permissionIds.length === 0) return 0;
    const existing = await RolePermission.findAll({ where: { roleId, permissionId: permissionIds }, transaction });
    const have = new Set(existing.map((link) => Number(link.permissionId)));
    const toAdd = permissionIds.filter((id) => !have.has(id));
    if (toAdd.length > 0) {
      await RolePermission.bulkCreate(toAdd.map((permissionId) => ({ roleId, permissionId })), { transaction });
    }
    return toAdd.length;
  },

  async revokePermission(roleId: number, permissionId: number) {
    return (await RolePermission.destroy({ where: { roleId, permissionId } })) > 0;
  },

  // Remplace l'ensemble des permissions du rôle par exactement la liste donnée
  async syncPermissions(roleId: number, permissionIds: number[]) {
    await sequelize.transaction(async (transaction) => {
      const where = permissionIds.length > 0 ? { roleId, permissionId: { [Op.notIn]: permissionIds } } : { roleId };
      await RolePermission.destroy({ where, transaction });
      await RbacModel.grantPermissions(roleId, permissionIds, transaction);
    });
  },

  // Nombre d'utilisateurs actifs portant ce rôle (garde-fou : toujours garder un admin)
  async countActiveUsersWithRole(roleId: number) {
    const [row] = await sequelize.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM role_user ru
       JOIN users u ON u.id = ru.user_id
       WHERE ru.role_id = :roleId AND u.is_active = TRUE`,
      { replacements: { roleId }, type: QueryTypes.SELECT }
    );
    return Number(row?.total ?? 0);
  },
};
