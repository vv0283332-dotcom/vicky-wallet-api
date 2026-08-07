import express from "express";
import protect from "../middleware/protect.js";

import {
 transfer
} from "../controllers/transferController.js";


const router=express.Router();


router.use(protect);


router.post("/",transfer);


export default router;
