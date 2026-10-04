import { TransportModel } from "../../models/transport.model";
import { alertTransportView } from "../../views/transport.view";

// Joint aux alertes « transport » les lignes concernées : le bandeau peut afficher « S1, T1 » en couleur et un bouton
// « Trouver un autre trajet ». Une seule requête pour toute la liste.
export async function withTransport<T extends { id: number; hazard: string }>(views: T[]) {
  const ids = views.filter((view) => view.hazard === "transport").map((view) => view.id);
  const disruptions = await TransportModel.listByAlert(ids);
  return views.map((view) =>
    view.hazard === "transport" ? { ...view, transport: alertTransportView(disruptions.filter((d) => d.alertId === view.id)) } : view
  );
}
