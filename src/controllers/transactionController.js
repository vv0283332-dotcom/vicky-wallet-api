import Transaction from "../models/Transaction.js";


export async function getTransactions(req,res){

  try{

    const transactions = await Transaction.find({
      $or:[
        {
          from:req.user._id
        },
        {
          to:req.user._id
        },
        {
          user:req.user._id
        }
      ]
    })
    .sort({
      createdAt:-1
    });


    res.json({
      transactions
    });


  }catch(error){

    res.status(500).json({
      message:error.message
    });

  }

}
