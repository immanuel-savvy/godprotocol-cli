const services_config = {
  [process.env.PLATFORM_NAME]: {
    local: "..",
    uri: process.env.PLATFORM_URI,
    api_key: process.env.API_KEY,
  },
};

const gp_services_config = {
  identity: {
    url: process.env.DEV
      ? "http://localhost:4000"
      : "https://profile-api.savvyaisolution.com",
    uri: "profiles.savvyaisolution.com",
    api_key: process.env.API_KEY,
  },
};

export { gp_services_config };
export default services_config;
