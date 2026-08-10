import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/db";

// Dev-only default password so the seeded account can actually log in locally.
// Change this (or the account's password) before any real deployment.
const DEV_PASSWORD = "soroi-dev-2026";

async function main() {
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
  const user = await prisma.user.upsert({
    where: { email: "yasinmanjothi@gmail.com" },
    update: { role: "RATE_MANAGER", passwordHash },
    create: {
      email: "yasinmanjothi@gmail.com",
      name: "Yasin Manjothi",
      role: "RATE_MANAGER",
      passwordHash,
    },
  });
  console.log(`Seeded ${user.email} as ${user.role}.`);
  console.log(`Dev login password: ${DEV_PASSWORD} (dev-only, change before any real deployment).`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
