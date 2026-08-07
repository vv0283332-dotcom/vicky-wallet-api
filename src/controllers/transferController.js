import User from "../models/User.js";
import Wallet from "../models/Wallet.js";
import Transaction from "../models/Transaction.js";


export async function transfer(req,res){

  try{

    const { receiverEmail, amount } = req.body;

    const transferAmount = Number(amount);


    if(!receiverEmail || !transferAmount || transferAmount <= 0){

      return res.status(400).json({
        message:"Receiver and valid amount are required"
      });

    }


    const receiver = await User.findOne({
      email: receiverEmail
    });


    if(!receiver){

      return res.status(404).json({
        message:"Receiver not found"
      });

    }


    if(receiver._id.toString() === req.user._id.toString()){

      return res.status(400).json({
        message:"Cannot transfer to yourself"
      });

    }



    const senderWallet = await Wallet.findOne({
      user:req.user._id
    });


    if(!senderWallet || senderWallet.balance < transferAmount){

      return res.status(400).json({
        message:"Insufficient balance"
      });

    }



    let receiverWallet = await Wallet.findOne({
      user:receiver._id
    });


    if(!receiverWallet){

      receiverWallet = await Wallet.create({
        user:receiver._id,
        balance:0
      });

    }



    senderWallet.balance -= transferAmount;

    receiverWallet.balance += transferAmount;



    await senderWallet.save();

    await receiverWallet.save();



    await Transaction.create({

      from:req.user._id,

      to:receiver._id,

      user:req.user._id,

      amount:transferAmount,

      type:"transfer",

      description:`Transfer to ${receiver.email}`

    });



    res.json({

      success:true,

      message:"Transfer successful",

      balance:senderWallet.balance

    });



  }catch(error){

    res.status(500).json({
      message:error.message
    });

  }

}
