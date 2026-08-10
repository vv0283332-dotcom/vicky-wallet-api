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
      provider_reference: `mock_${paymentId}`,
      amount,
      currency,
      status: "pending"
    };
  }

  async verifyPayment() {
    return {
      verified: false,
      status: "pending"
    };
  }

  verifyWebhook() {
    return false;
  }
}
