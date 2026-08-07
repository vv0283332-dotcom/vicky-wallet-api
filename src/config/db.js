import mongoose from "mongoose";
import env from "./env.js";

const connectDB = async () => {
  try {
    await mongoose.connect(env.mongoUri);
    console.log("✅ MongoDB Connected");
  } catch (error) {
    console.error("❌ Database connection failed:", error.message);
    process.exit(1);
  }
};

export default connectDB;
