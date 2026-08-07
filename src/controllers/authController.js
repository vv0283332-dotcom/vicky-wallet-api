import bcrypt from "bcryptjs";
import db from "../database/db.js";
import User from "../models/User.js";
import { createToken } from "../utils/jwt.js";


export async function register(req, res) {
  const { name, email, password } = req.body;

  await db.read();

  const exists = db.data.users.find(
    user => user.email === email
  );

  if (exists) {
    return res.status(400).json({
      message: "Email already registered"
    });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const user = new User({
    id: Date.now().toString(),
    name,
    email,
    password: hashedPassword
  });

  db.data.users.push(user);
  await db.write();

  const token = createToken(user.id);

  res.status(201).json({
    message: "Vicky Wallet account created",
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email
    }
  });
}


export async function login(req, res) {
  const { email, password } = req.body;

  await db.read();

  const user = db.data.users.find(
    user => user.email === email
  );

  if (!user) {
    return res.status(401).json({
      message: "Invalid login details"
    });
  }

  const match = await bcrypt.compare(
    password,
    user.password
  );

  if (!match) {
    return res.status(401).json({
      message: "Invalid login details"
    });
  }

  const token = createToken(user.id);

  res.json({
    message: "Login successful",
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email
    }
  });
}
