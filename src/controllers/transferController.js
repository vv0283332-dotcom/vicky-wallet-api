import db from "../database/db.js";
import Transaction from "../models/Transaction.js";


export async function transfer(req, res) {

  try {

    const { receiverEmail, amount } = req.body;


    if (!receiverEmail || !amount) {
      return res.status(400).json({
        message: "Receiver and amount are required"
      });
    }


    const transferAmount = Number(amount);


    if (transferAmount <= 0) {
      return res.status(400).json({
        message: "Invalid amount"
      });
    }


    await db.read();


    const sender = db.data.users.find(
      user => user.id === req.user.id
    );


    if (!sender) {
      return res.status(404).json({
        message: "Sender not found"
      });
    }


    const receiver = db.data.users.find(
      user => user.email === receiverEmail
    );


    if (!receiver) {
      return res.status(404).json({
        message: "Receiver not found"
      });
    }


    if (sender.id === receiver.id) {
      return res.status(400).json({
        message: "Cannot transfer to yourself"
      });
    }


    const senderWallet = db.data.wallets.find(
      wallet => wallet.userId === sender.id
    );


    if (!senderWallet || senderWallet.balance < transferAmount) {
      return res.status(400).json({
        message: "Insufficient balance"
      });
    }


    let receiverWallet = db.data.wallets.find(
      wallet => wallet.userId === receiver.id
    );


    if (!receiverWallet) {

      receiverWallet = {
        id: Date.now().toString(),
        userId: receiver.id,
        balance: 0,
        createdAt: new Date().toISOString()
      };

      db.data.wallets.push(receiverWallet);
    }


    senderWallet.balance -= transferAmount;

    receiverWallet.balance += transferAmount;



    db.data.transactions.push(

      new Transaction({
        id: Date.now().toString(),
        from: sender.id,
        to: receiver.id,
        amount: transferAmount,
        type: "transfer"
      })

    );


    await db.write();


    res.status(200).json({

      success: true,
      message: "Transfer successful",
      balance: senderWallet.balance

    });


  } catch (error) {

    res.status(500).json({
      message: error.message
    });

  }

}
