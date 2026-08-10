import { PaymentProvider } from "../provider-interface.js";

export class MockProvider extends PaymentProvider {
  constructor() {
    super("mock");
  }

  async createDeposit({ paymentId, amount, currency }) {
    return {
      provider: this.name,
      payment_id: paymentId,
      checkout_url: null,
      provider_reference: `mock_dep_${paymentId}`,
      amount,
      currency,
      status: "pending"
    };
  }

  async createWithdrawal({
    paymentId,
    amount,
    currency,
    destination
  }) {
    return {
      provider: this.name,
      payment_id: paymentId,
      provider_reference: `mock_wd_${paymentId}`,
      amount,
      currency,
      destination,
      status: "pending"
    };
  }

  async verifyPayment({ providerReference }) {
    return {
      verified: false,
      provider_reference: providerReference || null,
      status: "pending"
    };
  }

  async verifyWithdrawal({ providerReference }) {
    return {
      verified: false,
      provider_reference: providerReference || null,
      status: "pending"
    };
  }

  verifyWebhook() {
    return false;
  }

  async handleWebhook() {
    return {
      handled: false,
      status: "pending"
    };
  }
}
