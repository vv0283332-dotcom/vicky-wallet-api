import express from "express";
import protect from "../middleware/protect.js";

import {
 getMe,
 updateMe
} from "../controllers/userController.js";


const router=express.Router();


router.use(protect);


router.get("/me",getMe);

router.patch("/me",updateMe);


export default router;
