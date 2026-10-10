import { createFileRoute } from "@tanstack/react-router";
import { CalibrationScreen } from "@/components/ops/calibration-screen";

export const Route = createFileRoute("/_app/brands/$brandId/calibration")({ staticData: { pageTitle: "Calibration" }, component: CalibrationRoute });

function CalibrationRoute() {
  const { brandId } = Route.useParams();
  return <CalibrationScreen brandId={brandId} />;
}
