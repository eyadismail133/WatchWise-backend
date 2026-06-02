import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/index.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });

const prisma = new PrismaClient({ adapter });

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 25);
}

async function main() {
  const users = await prisma.user.findMany({
    where: { username: null },
    select: { id: true, name: true, email: true },
  });

  console.log(`Backfilling usernames for ${users.length} users...`);

  const taken = new Set<string>(
    (await prisma.user.findMany({ where: { username: { not: null } }, select: { username: true } }))
      .map((u: { username: string | null }) => u.username!)
  );

  for (const user of users) {
    const emailLocal = user.email.split("@")[0];
    const base = slugify(emailLocal) || slugify(user.name) || "user";
    const clamped = base.length < 3 ? base.padEnd(3, "0") : base;

    let candidate = clamped;
    let suffix = 1;
    while (taken.has(candidate)) {
      candidate = `${clamped.slice(0, 24)}${suffix}`;
      suffix++;
    }

    await prisma.user.update({ where: { id: user.id }, data: { username: candidate } });
    taken.add(candidate);
    console.log(`  user ${user.id} → @${candidate}`);
  }

  console.log("Done.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
