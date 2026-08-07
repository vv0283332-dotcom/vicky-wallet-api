class Transaction {
  constructor({
    id,
    from,
    to,
    amount,
    type
  }) {
    this.id = id;
    this.from = from;
    this.to = to;
    this.amount = amount;
    this.type = type;
    this.createdAt = new Date().toISOString();
  }
}

export default Transaction;
