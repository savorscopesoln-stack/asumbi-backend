#!/usr/bin/env node
/* Prints the env values for the Doravo Finance account (see utils/financeAccount.js).
   Usage: node scripts/finance-account-setup.js "<password>" [username]
   Nothing is stored anywhere: copy the lines into the server environment (e.g. Render) and restart. */
const bcrypt = require("bcrypt");
const { generateSecret, otpauthUri } = require("../utils/totp");

(async () => {
  const [password, username = "doravo-finance"] = process.argv.slice(2);
  if (!password || password.length < 10) {
    console.error('Usage: node scripts/finance-account-setup.js "<password of at least 10 characters>" [username]');
    process.exit(1);
  }
  const secret = generateSecret();
  console.log("# Add these to the server environment, then restart:");
  console.log(`FINANCE_USERNAME=${username}`);
  console.log(`FINANCE_PASSWORD_HASH=${await bcrypt.hash(password, 12)}`);
  console.log(`FINANCE_MFA_SECRET=${secret}`);
  console.log("\n# Authenticator app: add manually with this setup key, or paste this URI:");
  console.log(`#   ${secret}`);
  console.log(`#   ${otpauthUri(secret, { accountName: username })}`);
  console.log("\n# Note: hashes contain $ characters; wrap the value in single quotes if your shell or .env loader expands them.");
})();
