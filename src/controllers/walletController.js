import db from "../database/db.js";
import Wallet from "../models/Wallet.js";
import Transaction from "../models/Transaction.js";


export async function getWallet(req,res){

  await db.read();

  let wallet = db.data.wallets.find(
    w => w.userId === req.user.id
  );

  if(!wallet){

    wallet = new Wallet({
      id: Date.now().toString(),
      userId:req.user.id
    });

    db.data.wallets.push(wallet);
    await db.write();
  }


  res.json(wallet);
}



export async function deposit(req,res){

  const {amount} = req.body;

  await db.read();

  let wallet = db.data.wallets.find(
    w=>w.userId===req.user.id
  );


  if(!wallet){
    wallet=new Wallet({
      id:Date.now().toString(),
      userId:req.user.id
    });

    db.data.wallets.push(wallet);
  }


  wallet.balance += Number(amount);


  db.data.transactions.push(
    new Transaction({
      id:Date.now().toString(),
      from:"SYSTEM",
      to:req.user.id,
      amount:Number(amount),
      type:"deposit"
    })
  );


  await db.write();


  res.json({
    message:"Deposit successful",
    balance:wallet.balance
  });

}



export async function withdraw(req,res){

 const {amount}=req.body;

 await db.read();


 const wallet=db.data.wallets.find(
  w=>w.userId===req.user.id
 );


 if(!wallet || wallet.balance < amount){

  return res.status(400).json({
    message:"Insufficient balance"
  });

 }


 wallet.balance -= Number(amount);



 db.data.transactions.push(
 new Transaction({
 id:Date.now().toString(),
 from:req.user.id,
 to:"SYSTEM",
 amount:Number(amount),
 type:"withdrawal"
 })
 );


 await db.write();


 res.json({
 message:"Withdrawal successful",
 balance:wallet.balance
 });

}
