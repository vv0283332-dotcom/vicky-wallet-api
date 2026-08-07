import dotenv from "dotenv";

dotenv.config();

const env = {
  port: process.env.PORT || 5000,
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpires: process.env.JWT_EXPIRES_IN,
  nodeEnv: process.env.NODE_ENV,
};

if (!env.mongoUri) throw new Error("MONGO_URI is missing");
if (!env.jwtSecret) throw new Error("JWT_SECRET is missing");

export default env;
