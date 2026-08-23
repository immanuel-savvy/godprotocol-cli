import dotenv from "dotenv";
import GodProtocol from "godprotocol";

dotenv.config();

import router from "./routes/index.js";
import services_config, { gp_services_config } from "./services.config.js";

let gp = new GodProtocol({
  platform_uri: process.env.PLATFORM_URI,
  api_key: process.env.API_KEY,
  db_config: {
    db_name: process.env.REPOSITORY_NAME,
    db_url: process.env.REPOSITORY_URI,
  },
  capabilities: gp_services_config,
});

await router(gp, { services_config });

export default gp.on_request;
