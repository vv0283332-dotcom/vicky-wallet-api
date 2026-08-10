export class PaymentProvider {
  constructor(name, options = {}) {
    this.name = name;
    this.options = options;
  }

  async createDeposit() {
    throw new Error("createDeposit() is not implemented");
  }

  async createWithdrawal() {
    throw new Error("createWithdrawal() is not implemented");
  }

  async verifyPayment() {
    throw new Error("verifyPayment() is not implemented");
  }

  async verifyWithdrawal() {
    throw new Error("verifyWithdrawal() is not implemented");
  }

  verifyWebhook() {
    throw new Error("verifyWebhook() is not implemented");
  }

  async handleWebhook() {
    throw new Error("handleWebhook() is not implemented");
  }
}
