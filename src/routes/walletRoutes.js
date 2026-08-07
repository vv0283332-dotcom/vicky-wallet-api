import express from "express";

import protect from "../middleware/protect.js";

import {
 getWallet,
 deposit,
 withdraw
} from "../controllers/walletController.js";


const router = express.Router();


router.use(protect);


router.get("/", getWallet);

router.post("/deposit", deposit);

router.post("/withdraw", withdraw);


export default router;
