export class PaymentProvider {
  constructor(name) {
    this.name = name;
  }

  async createDeposit() {
    throw new Error("createDeposit() is not implemented");
  }

  async verifyPayment() {
    throw new Error("verifyPayment() is not implemented");
  }

  verifyWebhook() {
    throw new Error("verifyWebhook() is not implemented");
  }
}
