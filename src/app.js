import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import authRoutes from "./routes/authRoutes.js";
import walletRoutes from "./routes/walletRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import transferRoutes from "./routes/transferRoutes.js";
import transactionRoutes from "./routes/transactionRoutes.js";


const app = express();


app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(morgan("dev"));


app.get("/", (req,res)=>{
  res.json({
    success:true,
    message:"Welcome to Vicky Wallet API"
  });
});


app.use("/api/auth", authRoutes);

app.use("/api/wallet", walletRoutes);

app.use("/api/users", userRoutes);

app.use("/api/transfer", transferRoutes);

app.use("/api/transactions", transactionRoutes);



export default app;
