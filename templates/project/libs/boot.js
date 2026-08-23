import { Mongo } from "@godprotocol/repositories";

const boots = async () => {
  let db = new Mongo({
    db_url: process.env.REPOSITORY_URI,
    db_name: process.env.REPOSITORY_NAME,
  });
};

export { boots };
