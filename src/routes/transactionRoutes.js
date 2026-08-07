import express from "express";
import protect from "../middleware/protect.js";

import {
  getTransactions
} from "../controllers/transactionController.js";


const router = express.Router();


router.use(protect);


router.get("/", getTransactions);


export default router;
