import {
  CreationOptional,
  DataTypes,
  IncludeOptions,
  InferAttributes,
  InferCreationAttributes,
  Model,
  NonAttribute,
  Transaction,
} from "sequelize";
import sequelize from "../config/database";
import { ExternalEntity } from "./externalEntity.model";
import { User } from "./user.model";

export const PROJECT_STATUSES = ["planned", "ongoing", "completed"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

type AuthorRef = Pick<User, "id" | "firstName" | "lastName">;
type ParticipantRef = Pick<User, "id" | "firstName" | "lastName" | "email">;
type EntityRef = Pick<ExternalEntity, "id" | "name" | "type">;

// ── Table projects ─────────────────────────────────────────────
export class Project extends Model<InferAttributes<Project>, InferCreationAttributes<Project>> {
  declare id: CreationOptional<number>;
  declare title: string;
  declare description: CreationOptional<string | null>;
  declare imageUrl: CreationOptional<string | null>;
  declare status: CreationOptional<ProjectStatus>;
  // Pertinent seulement quand status = "ongoing" ; null sinon
  declare progress: CreationOptional<number | null>;
  declare authorId: CreationOptional<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare author?: NonAttribute<AuthorRef | null>;
  declare participants?: NonAttribute<ParticipantRef[]>;
  declare externalEntities?: NonAttribute<EntityRef[]>;
}

Project.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    title: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    imageUrl: { type: DataTypes.STRING(500), allowNull: true },
    status: { type: DataTypes.ENUM(...PROJECT_STATUSES), allowNull: false, defaultValue: "ongoing" },
    progress: { type: DataTypes.SMALLINT, allowNull: true },
    authorId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: User, key: "id" },
      onDelete: "SET NULL",
    },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "projects", underscored: true }
);

// ── Table project_participants (citoyens/agents associés) ──────
export class ProjectParticipant extends Model<
  InferAttributes<ProjectParticipant>,
  InferCreationAttributes<ProjectParticipant>
> {
  declare id: CreationOptional<number>;
  declare projectId: number;
  declare userId: number;
  declare addedAt: CreationOptional<Date>;
  declare addedBy: CreationOptional<number | null>;
  declare user?: NonAttribute<ParticipantRef | null>;
}

ProjectParticipant.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    projectId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: Project, key: "id" },
      onDelete: "CASCADE",
    },
    userId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: User, key: "id" },
      onDelete: "CASCADE",
    },
    addedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    addedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
  },
  { sequelize, tableName: "project_participants", underscored: true, timestamps: false }
);

// ── Table project_external_entities (entités externes associées) ─
export class ProjectExternalEntity extends Model<
  InferAttributes<ProjectExternalEntity>,
  InferCreationAttributes<ProjectExternalEntity>
> {
  declare id: CreationOptional<number>;
  declare projectId: number;
  declare externalEntityId: number;
  declare addedAt: CreationOptional<Date>;
  declare addedBy: CreationOptional<number | null>;
  declare entity?: NonAttribute<EntityRef | null>;
}

ProjectExternalEntity.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    projectId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: Project, key: "id" },
      onDelete: "CASCADE",
    },
    externalEntityId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: ExternalEntity, key: "id" },
      onDelete: "CASCADE",
    },
    addedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    addedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
  },
  { sequelize, tableName: "project_external_entities", underscored: true, timestamps: false }
);

// ── Table project_comments (les "critiques" citoyennes) ─────────
export class ProjectComment extends Model<InferAttributes<ProjectComment>, InferCreationAttributes<ProjectComment>> {
  declare id: CreationOptional<number>;
  declare projectId: number;
  declare userId: number;
  declare content: string;
  declare createdAt: CreationOptional<Date>;
  declare author?: NonAttribute<AuthorRef | null>;
}

ProjectComment.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    projectId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: Project, key: "id" },
      onDelete: "CASCADE",
    },
    userId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: User, key: "id" },
      onDelete: "CASCADE",
    },
    content: { type: DataTypes.TEXT, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "project_comments", underscored: true, timestamps: true, updatedAt: false }
);

Project.belongsTo(User, { foreignKey: "authorId", as: "author" });
Project.belongsToMany(User, { through: ProjectParticipant, foreignKey: "projectId", otherKey: "userId", as: "participants" });
Project.belongsToMany(ExternalEntity, {
  through: ProjectExternalEntity,
  foreignKey: "projectId",
  otherKey: "externalEntityId",
  as: "externalEntities",
});
ProjectParticipant.belongsTo(Project, { foreignKey: "projectId", as: "project" });
ProjectParticipant.belongsTo(User, { foreignKey: "userId", as: "user" });
ProjectExternalEntity.belongsTo(Project, { foreignKey: "projectId", as: "project" });
ProjectExternalEntity.belongsTo(ExternalEntity, { foreignKey: "externalEntityId", as: "entity" });
ProjectComment.belongsTo(Project, { foreignKey: "projectId", as: "project" });
ProjectComment.belongsTo(User, { foreignKey: "userId", as: "author" });

export type ProjectData = InferAttributes<Project> & {
  author?: AuthorRef | null;
  participants?: ParticipantRef[];
  externalEntities?: EntityRef[];
};

export type ProjectInput = {
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  status?: ProjectStatus;
  progress?: number | null;
};
export type ProjectUpdate = Partial<ProjectInput>;

export type ProjectCommentData = InferAttributes<ProjectComment> & { author?: AuthorRef | null };

const withRelations: IncludeOptions[] = [
  { model: User, as: "author", attributes: ["id", "firstName", "lastName"] },
  {
    model: User,
    as: "participants",
    attributes: ["id", "firstName", "lastName", "email"],
    through: { attributes: [] },
  },
  { model: ExternalEntity, as: "externalEntities", attributes: ["id", "name", "type"], through: { attributes: [] } },
];

const plain = (row: Project | null) => (row?.get({ plain: true }) as ProjectData) ?? null;

export const ProjectModel = {
  async list(): Promise<ProjectData[]> {
    const rows = await Project.findAll({ include: withRelations, order: [["createdAt", "DESC"]] });
    return rows.map((row) => row.get({ plain: true }) as ProjectData);
  },

  // Les N projets les plus récents : alimente la page d'accueil publique
  async listLatest(limit: number): Promise<ProjectData[]> {
    const rows = await Project.findAll({ include: withRelations, order: [["createdAt", "DESC"]], limit });
    return rows.map((row) => row.get({ plain: true }) as ProjectData);
  },

  async findById(id: number): Promise<ProjectData | null> {
    return plain(await Project.findByPk(id, { include: withRelations }));
  },

  async create(data: ProjectInput, authorId: number | null): Promise<ProjectData> {
    const created = await Project.create({ ...data, authorId });
    return (await ProjectModel.findById(created.id))!;
  },

  async update(id: number, data: ProjectUpdate): Promise<ProjectData | null> {
    const project = await Project.findByPk(id);
    if (!project) return null;
    await project.update(data);
    return ProjectModel.findById(id);
  },

  async delete(id: number): Promise<boolean> {
    return (await Project.destroy({ where: { id } })) > 0;
  },

  // Idempotent : renvoie false si déjà associé
  async addParticipant(projectId: number, userId: number, addedBy: number | null): Promise<boolean> {
    const [, created] = await ProjectParticipant.findOrCreate({
      where: { projectId, userId },
      defaults: { projectId, userId, addedBy },
    });
    return created;
  },

  async removeParticipant(projectId: number, userId: number): Promise<boolean> {
    return (await ProjectParticipant.destroy({ where: { projectId, userId } })) > 0;
  },

  async addExternalEntity(projectId: number, externalEntityId: number, addedBy: number | null): Promise<boolean> {
    const [, created] = await ProjectExternalEntity.findOrCreate({
      where: { projectId, externalEntityId },
      defaults: { projectId, externalEntityId, addedBy },
    });
    return created;
  },

  async removeExternalEntity(projectId: number, externalEntityId: number): Promise<boolean> {
    return (await ProjectExternalEntity.destroy({ where: { projectId, externalEntityId } })) > 0;
  },
};

export const ProjectCommentModel = {
  async listByProject(projectId: number): Promise<ProjectCommentData[]> {
    const rows = await ProjectComment.findAll({
      where: { projectId },
      include: [{ model: User, as: "author", attributes: ["id", "firstName", "lastName"] }],
      order: [["createdAt", "ASC"]],
    });
    return rows.map((row) => row.get({ plain: true }) as ProjectCommentData);
  },

  async create(data: { projectId: number; userId: number; content: string }, transaction?: Transaction): Promise<ProjectCommentData> {
    const created = await ProjectComment.create(data, { transaction });
    const withAuthor = await ProjectComment.findByPk(created.id, {
      include: [{ model: User, as: "author", attributes: ["id", "firstName", "lastName"] }],
      transaction,
    });
    return withAuthor!.get({ plain: true }) as ProjectCommentData;
  },

  async findById(id: number): Promise<ProjectCommentData | null> {
    const row = await ProjectComment.findByPk(id);
    return row?.get({ plain: true }) ?? null;
  },

  async delete(id: number): Promise<boolean> {
    return (await ProjectComment.destroy({ where: { id } })) > 0;
  },
};
