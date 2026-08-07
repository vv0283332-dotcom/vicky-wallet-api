class Wallet {
  constructor({
    id,
    userId,
    balance = 0
  }) {
    this.id = id;
    this.userId = userId;
    this.balance = balance;
    this.createdAt = new Date().toISOString();
  }
}

export default Wallet;
