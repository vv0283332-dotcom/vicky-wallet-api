import db from "../database/db.js";
import { verifyToken } from "../utils/jwt.js";


export default async function protect(req,res,next){

  const header = req.headers.authorization;


  if(!header || !header.startsWith("Bearer ")){

    return res.status(401).json({
      message:"Not authorized"
    });

  }


  const token = header.split(" ")[1];


  try{

    const decoded = verifyToken(token);

    await db.read();


    const user = db.data.users.find(
      u => u.id === decoded.id
    );


    if(!user){

      return res.status(401).json({
        message:"User not found"
      });

    }


    req.user = user;

    next();


  }catch(error){

    return res.status(401).json({
      message:"Invalid token"
    });

  }

}
