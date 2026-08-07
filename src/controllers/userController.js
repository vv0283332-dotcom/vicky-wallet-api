import db from "../database/db.js";


export async function getMe(req,res){

  res.json({
    id:req.user.id,
    name:req.user.name,
    email:req.user.email
  });

}


export async function updateMe(req,res){

  const {name}=req.body;

  await db.read();


  const user=db.data.users.find(
    u=>u.id===req.user.id
  );


  if(name){
    user.name=name;
  }


  await db.write();


  res.json({
    message:"Profile updated",
    user
  });

}
