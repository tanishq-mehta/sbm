import { hashPassword } from "../server/auth.mjs";

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error("Usage: npm run auth:user -- <username> <password>");
  process.exit(1);
}

console.log(
  JSON.stringify({
    username,
    passwordHash: hashPassword(password),
  })
);
