import request from "supertest";
import app from "../src/app.js";

describe("Vicky Wallet Transfer API", () => {

  let senderToken;
  let receiverToken;
  let senderWalletBefore;

  test("Register sender", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        name: "Sender User",
        email: "sender@test.com",
        password: "123456"
      });

    expect(res.statusCode).toBe(201);
  });


  test("Register receiver", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        name: "Receiver User",
        email: "receiver@test.com",
        password: "123456"
      });

    expect(res.statusCode).toBe(201);
  });


  test("Login sender", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({
        email: "sender@test.com",
        password: "123456"
      });

    expect(res.statusCode).toBe(200);

    senderToken = res.body.token || res.body.access_token;
  });


  test("Login receiver", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({
        email: "receiver@test.com",
        password: "123456"
      });

    expect(res.statusCode).toBe(200);

    receiverToken = res.body.token || res.body.access_token;
  });


  test("Deposit money to sender", async () => {
    const res = await request(app)
      .post("/api/wallet/deposit")
      .set("Authorization", `Bearer ${senderToken}`)
      .send({
        amount: 1000
      });

    expect(res.statusCode).toBe(200);
  });


  test("Transfer money sender to receiver", async () => {
    const res = await request(app)
      .post("/api/transfer/")

      .set("Authorization", `Bearer ${senderToken}`)
      .send({
        receiverEmail: "receiver@test.com",
        amount: 300
      });

    expect(res.statusCode).toBe(200);
  });


  test("Check sender transactions", async () => {
    const res = await request(app)
      .get("/api/transactions")
      .set("Authorization", `Bearer ${senderToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBeDefined();
  });

});
