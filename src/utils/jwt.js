import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "vicky_wallet_secret";

export function createToken(userId) {
  return jwt.sign(
    { id: userId },
    SECRET,
    { expiresIn: "7d" }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET);
}
