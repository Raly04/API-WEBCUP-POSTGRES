import type { IdeaData } from "../models/idea.model";

export interface IdeaView {
  id: number;
  // Référence courte et lisible : la preuve affichée à l'habitant que son idée est enregistrée
  reference: string;
  content: string;
  createdAt: Date;
}

export function ideaView(idea: IdeaData): IdeaView {
  const { id, content, createdAt } = idea;
  return { id, reference: `IDEE-${id}`, content, createdAt };
}

// Vue des administrateurs : avec l'auteur, pour savoir qui porte l'idée
export interface IdeaStaffView extends IdeaView {
  author: { id: number; name: string } | null;
}

export function ideaStaffView(idea: IdeaData): IdeaStaffView {
  const { author } = idea;
  return {
    ...ideaView(idea),
    // null si le compte de l'auteur a été supprimé (FK ON DELETE CASCADE : la ligne disparaît aussi)
    author: author ? { id: author.id, name: `${author.firstName} ${author.lastName}`.trim() } : null,
  };
}