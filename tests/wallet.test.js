import request from "supertest";
import app from "../src/app.js";

let token = "";

describe("Vicky Wallet API", () => {

  test("Register user", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        name: "Test User",
        email: "testuser@example.com",
        password: "password123"
      });

    expect(res.statusCode).toBe(201);
  });


  test("Login user", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({
        email: "testuser@example.com",
        password: "password123"
      });

    expect(res.statusCode).toBe(200);

    token = res.body.token || res.body.access_token;
    expect(token).toBeTruthy();
  });


  test("Get wallet", async () => {
    const res = await request(app)
      .get("/api/wallet")
      .set("Authorization", `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
  });

});
test("Deposit funds", async () => {
  const res = await request(app)
    .post("/api/wallet/deposit")
    .set("Authorization", `Bearer ${token}`)
    .send({
      amount: 1000
    });

  expect(res.statusCode).toBe(200);
});


test("Withdraw funds", async () => {
  const res = await request(app)
    .post("/api/wallet/withdraw")
    .set("Authorization", `Bearer ${token}`)
    .send({
      amount: 100
    });

  expect(res.statusCode).toBe(200);
});


test("Get transactions", async () => {
  const res = await request(app)
    .get("/api/transactions")
    .set("Authorization", `Bearer ${token}`);

  expect(res.statusCode).toBe(200);
});
