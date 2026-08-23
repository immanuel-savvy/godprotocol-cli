import handler from "./{{PROJECT_NAME}}.js";

import http from "http";

let server = http.createServer(handler);

let port = process.env.PORT;

server.listen(port, async () => {
  console.log(`{{PROJECT_NAME}} is listening on http://localhost:${port}`);
});
