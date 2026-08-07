import db from "../database/db.js";
import Transaction from "../models/Transaction.js";


export async function transfer(req,res){

const {receiverId,amount}=req.body;


await db.read();


const senderWallet=db.data.wallets.find(
 w=>w.userId===req.user.id
);


const receiverWallet=db.data.wallets.find(
 w=>w.userId===receiverId
);


if(!senderWallet || senderWallet.balance < amount){

return res.status(400).json({
message:"Insufficient balance"
});

}


if(!receiverWallet){

return res.status(404).json({
message:"Receiver wallet not found"
});

}


senderWallet.balance -= Number(amount);

receiverWallet.balance += Number(amount);



db.data.transactions.push(
new Transaction({
id:Date.now().toString(),
from:req.user.id,
to:receiverId,
amount:Number(amount),
type:"transfer"
})
);



await db.write();


res.json({
message:"Transfer successful"
});

}
