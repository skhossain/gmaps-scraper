// Usage: npm run create-admin            (interactive)
//        npm run create-admin -- <username>   (asks for the password)
// Creates a super admin, or resets the password if the username already exists.
const readline = require('readline');
const { db } = require('../database');
const { createUser, setPassword, listUsers } = require('../auth');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

(async () => {
  const username = process.argv[2] || (await ask('Admin username: '));
  const existing = listUsers().find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (existing) console.log(`User "${existing.username}" already exists - this will reset their password and make them admin.`);

  const password = await ask('Password (min 8 chars): ', { hidden: true });
  const confirm = await ask('Confirm password: ', { hidden: true });
  if (password !== confirm) { console.error('Passwords do not match.'); process.exit(1); }

  try {
    if (existing) {
      setPassword(existing.id, password);
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
      console.log(`Password reset for admin "${existing.username}".`);
    } else {
      createUser(username, password, 'admin');
      console.log(`Admin "${username}" created. You can now log in.`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
