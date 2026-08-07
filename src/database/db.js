import { JSONFilePreset } from "lowdb/node";


const defaultData = {

users: [],

wallets: [],

transactions: []

};


const db = await JSONFilePreset(
"src/database/vicky_wallet.json",
defaultData
);


export default db;
