import Wallet from "../models/Wallet.js";
import Transaction from "../models/Transaction.js";


export async function getWallet(req,res){

  try {

    let wallet = await Wallet.findOne({
      user:req.user._id
    });


    if(!wallet){

      wallet = await Wallet.create({
        user:req.user._id,
        balance:0
      });

    }


    res.json(wallet);


  } catch(error){

    res.status(500).json({
      message:error.message
    });

  }

}



export async function deposit(req,res){

  try {

    const amount = Number(req.body.amount);


    if(!amount || amount <= 0){

      return res.status(400).json({
        message:"Invalid amount"
      });

    }


    let wallet = await Wallet.findOne({
      user:req.user._id
    });


    if(!wallet){

      wallet = await Wallet.create({
        user:req.user._id,
        balance:0
      });

    }


    wallet.balance += amount;

    await wallet.save();



    await Transaction.create({

      from:null,

      to:req.user._id,

      user:req.user._id,

      amount,

      type:"deposit",

      description:"Wallet deposit"

    });



    res.json({

      message:"Deposit successful",

      balance:wallet.balance

    });



  } catch(error){

    res.status(500).json({
      message:error.message
    });

  }

}





export async function withdraw(req,res){

  try {


    const amount = Number(req.body.amount);


    const wallet = await Wallet.findOne({
      user:req.user._id
    });



    if(!wallet || wallet.balance < amount){

      return res.status(400).json({
        message:"Insufficient balance"
      });

    }



    wallet.balance -= amount;

    await wallet.save();



    await Transaction.create({

      from:req.user._id,

      to:null,

      user:req.user._id,

      amount,

      type:"withdrawal",

      description:"Wallet withdrawal"

    });



    res.json({

      message:"Withdrawal successful",

      balance:wallet.balance

    });



  } catch(error){

    res.status(500).json({
      message:error.message
    });

  }

}
