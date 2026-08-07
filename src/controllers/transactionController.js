import db from "../database/db.js";


export async function getTransactions(req,res){

  await db.read();


  const transactions = db.data.transactions.filter(
    t =>
      t.from === req.user.id ||
      t.to === req.user.id
  );


  res.json({
    transactions
  });

}
