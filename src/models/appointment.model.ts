import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  IncludeOptions,
  Model,
  NonAttribute,
  Op,
  Transaction,
} from "sequelize";
import sequelize from "../config/database";
import { MunicipalService } from "./municipalService.model";
import { User } from "./user.model";

export const APPOINTMENT_STATUSES = ["open", "booked", "cancelled"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export function isAppointmentStatus(value: unknown): value is AppointmentStatus {
  return (APPOINTMENT_STATUSES as readonly unknown[]).includes(value);
}

// ── Table appointments ────────────────────────────────────────
// Un créneau est créé "open" par un agent, puis réservé par un citoyen (book),
// jamais remis en circulation : une annulation est un état terminal, pas un retour
// au pool, pour qu'un citoyen ne se demande jamais si son horaire a changé de main.
export class Appointment extends Model<InferAttributes<Appointment>, InferCreationAttributes<Appointment>> {
  declare id: CreationOptional<number>;
  declare agentId: number;
  declare serviceId: CreationOptional<number | null>;
  declare citizenId: CreationOptional<number | null>;
  declare startAt: Date;
  declare endAt: Date;
  declare location: CreationOptional<string | null>;
  declare instructions: CreationOptional<string | null>;
  declare subject: CreationOptional<string | null>;
  declare status: CreationOptional<AppointmentStatus>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date | null>;
  declare agent?: NonAttribute<Pick<User, "id" | "firstName" | "lastName"> | null>;
  declare citizen?: NonAttribute<Pick<User, "id" | "firstName" | "lastName"> | null>;
  declare service?: NonAttribute<Pick<MunicipalService, "id" | "code" | "name"> | null>;
}

Appointment.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    agentId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    serviceId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    citizenId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    startAt: { type: DataTypes.DATE, allowNull: false },
    endAt: { type: DataTypes.DATE, allowNull: false },
    location: { type: DataTypes.STRING(255), allowNull: true },
    instructions: { type: DataTypes.TEXT, allowNull: true },
    subject: { type: DataTypes.STRING(500), allowNull: true },
    status: { type: DataTypes.ENUM(...APPOINTMENT_STATUSES), allowNull: false, defaultValue: "open" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: "appointments", underscored: true }
);

Appointment.belongsTo(User, { foreignKey: "agentId", as: "agent" });
Appointment.belongsTo(User, { foreignKey: "citizenId", as: "citizen" });
Appointment.belongsTo(MunicipalService, { foreignKey: "serviceId", as: "service" });

export type AppointmentData = InferAttributes<Appointment> & {
  agent?: Pick<User, "id" | "firstName" | "lastName"> | null;
  citizen?: Pick<User, "id" | "firstName" | "lastName"> | null;
  service?: Pick<MunicipalService, "id" | "code" | "name"> | null;
};

export interface SlotInput {
  agentId: number;
  serviceId: number | null;
  startAt: Date;
  endAt: Date;
  location: string | null;
  instructions: string | null;
}

const withRelations: IncludeOptions[] = [
  { model: User, as: "agent", attributes: ["id", "firstName", "lastName"] },
  { model: User, as: "citizen", attributes: ["id", "firstName", "lastName"] },
  { model: MunicipalService, as: "service", attributes: ["id", "code", "name"] },
];

const plain = (row: Appointment | null) => (row?.get({ plain: true }) as AppointmentData) ?? null;

export const AppointmentModel = {
  // Créneaux ouverts, visibles par les citoyens. On exclut les créneaux déjà passés :
  // un horaire révolu n'est plus une option, peu importe son statut en base.
  async listOpenSlots(filters: { serviceId?: number; limit: number; offset: number }) {
    const where: Record<string | symbol, unknown> = { status: "open", startAt: { [Op.gt]: new Date() } };
    if (filters.serviceId !== undefined) where.serviceId = filters.serviceId;

    const { rows, count } = await Appointment.findAndCountAll({
      where,
      include: [...withRelations],
      order: [["startAt", "ASC"]],
      limit: filters.limit,
      offset: filters.offset,
      distinct: true,
    });
    return { slots: rows.map((row) => row.get({ plain: true }) as AppointmentData), total: count };
  },

  async findById(id: number, transaction?: Transaction): Promise<AppointmentData | null> {
    return plain(await Appointment.findByPk(id, { include: [...withRelations], transaction }));
  },

  async findOwnSlotById(id: number, agentId: number): Promise<AppointmentData | null> {
    return plain(await Appointment.findOne({ where: { id, agentId }, include: [...withRelations] }));
  },

  // Chevauchement sur les créneaux non annulés du même agent : un citoyen ne doit
  // jamais avoir à choisir entre deux horaires qui se recouvrent chez le même agent.
  async hasOverlap(agentId: number, startAt: Date, endAt: Date): Promise<boolean> {
    const count = await Appointment.count({
      where: {
        agentId,
        status: { [Op.ne]: "cancelled" },
        startAt: { [Op.lt]: endAt },
        endAt: { [Op.gt]: startAt },
      },
    });
    return count > 0;
  },

  async createSlot(data: SlotInput): Promise<AppointmentData> {
    const created = await Appointment.create({ ...data, citizenId: null, subject: null, status: "open" });
    return (await AppointmentModel.findById(created.id))!;
  },

  /** Historique des rendez-vous du citoyen (réservés et annulés), le plus récent/proche en premier. */
  async listMine(citizenId: number, filters: { limit: number; offset: number }) {
    const { rows, count } = await Appointment.findAndCountAll({
      where: { citizenId },
      include: [...withRelations],
      order: [["startAt", "DESC"]],
      limit: filters.limit,
      offset: filters.offset,
      distinct: true,
    });
    return { appointments: rows.map((row) => row.get({ plain: true }) as AppointmentData), total: count };
  },

  async listForAgent(agentId: number, filters: { status?: AppointmentStatus; limit: number; offset: number }) {
    const where: Record<string, unknown> = { agentId };
    if (filters.status) where.status = filters.status;
    const { rows, count } = await Appointment.findAndCountAll({
      where,
      include: [...withRelations],
      order: [["startAt", "ASC"]],
      limit: filters.limit,
      offset: filters.offset,
      distinct: true,
    });
    return { appointments: rows.map((row) => row.get({ plain: true }) as AppointmentData), total: count };
  },

  // Réservation atomique : l'UPDATE ne porte que sur un créneau encore "open", donc deux
  // citoyens qui cliquent au même instant ne peuvent jamais obtenir tous les deux le même
  // horaire. Le second reçoit 0 ligne affectée, jamais une réservation fantôme.
  async book(id: number, citizenId: number, subject: string | null): Promise<AppointmentData | null> {
    return sequelize.transaction(async (transaction) => {
      const [affected] = await Appointment.update(
        { citizenId, subject, status: "booked" },
        { where: { id, status: "open" }, transaction }
      );
      if (affected === 0) return null;
      return AppointmentModel.findById(id, transaction);
    });
  },

  async cancelByCitizen(id: number, citizenId: number): Promise<boolean> {
    const [affected] = await Appointment.update(
      { status: "cancelled" },
      { where: { id, citizenId, status: "booked" } }
    );
    return affected > 0;
  },

  async cancelByAgent(id: number, agentId: number): Promise<boolean> {
    const [affected] = await Appointment.update(
      { status: "cancelled" },
      { where: { id, agentId, status: { [Op.ne]: "cancelled" } } }
    );
    return affected > 0;
  },

  // agent_id est en ON DELETE RESTRICT : la suppression d'un compte agent échouerait en base
  // s'il possédait encore des créneaux. On le vérifie avant, pour renvoyer un message
  // exploitable plutôt qu'une erreur serveur.
  countAgentSlots(agentId: number) {
    return Appointment.count({ where: { agentId } });
  },

  // Suppression réservée aux créneaux jamais réservés : au-delà, seule l'annulation
  // garde une trace pour le citoyen concerné.
  async deleteOpenSlot(id: number, agentId: number): Promise<boolean> {
    return (await Appointment.destroy({ where: { id, agentId, status: "open" } })) > 0;
  },

  // Remet un créneau annulé en circulation. citizenId/subject sont effacés : le créneau
  // redevient un horaire neutre, pas la réservation (annulée) d'un citoyen en particulier.
  // startAt reste dans le futur : un rendez-vous passé ne peut pas redevenir réservable,
  // sinon le citizen aurait à réserver un créneau déjà écoulé.
  async reopenByAgent(id: number, agentId: number): Promise<boolean> {
    const [affected] = await Appointment.update(
      { status: "open", citizenId: null, subject: null },
      { where: { id, agentId, status: "cancelled", startAt: { [Op.gt]: new Date() } } }
    );
    return affected > 0;
  },
};
