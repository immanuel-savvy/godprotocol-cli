import services from "../services/index.js";
import router_v1 from "./router-v1.js";

let router = async (gp, opts = {}) => {
  let { services_config } = opts;

  const prefix = gp.utils.validateRouter(
    process.env.PLATFORM_NAME,
    services_config,
  );
  if (!prefix) return;

  await gp.add_router("v1", router_v1, { prefix, services, services_config });
};

export default router;
