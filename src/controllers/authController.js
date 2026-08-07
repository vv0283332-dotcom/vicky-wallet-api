import bcrypt from "bcryptjs";
import User from "../models/User.js";
import Wallet from "../models/Wallet.js";
import { createToken } from "../utils/jwt.js";


export async function register(req, res) {
  try {
    const { name, email, password } = req.body;

    const exists = await User.findOne({ email });

    if (exists) {
      return res.status(400).json({
        message: "Email already registered"
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email,
      password: hashedPassword
    });

    await Wallet.create({
      user: user._id,
      balance: 0
    });

    const token = createToken(user._id);

    res.status(201).json({
      message: "Vicky Wallet account created",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email
      }
    });

  } catch (error) {
    res.status(500).json({
      message: error.message
    });
  }
}


export async function login(req, res) {
  try {

    const { email, password } = req.body;

    const user = await User.findOne({ email });

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


    const token = createToken(user._id);


    res.json({
      message: "Login successful",
      token,
      user:{
        id:user._id,
        name:user.name,
        email:user.email
      }
    });


  } catch(error){

    res.status(500).json({
      message:error.message
    });

  }
}
